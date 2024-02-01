import { Stack, aws_kinesisvideo as kinesisvideo } from 'aws-cdk-lib';
import { SecurityGroup, Port, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import {
  ContainerImage,
  CpuArchitecture,
  OperatingSystemFamily,
} from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { ApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {
  ManagedPolicy,
  Role,
  PolicyStatement,
  PolicyDocument,
  ServicePrincipal,
  // AccountPrincipal,
  ArnPrincipal,
  CompositePrincipal,
  AccountPrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface ECSResourcesProps {
  vpc: Vpc;
  kvsProducerAlbSecurityGroup: SecurityGroup;
  sourceBucket: Bucket;
  logLevel: string;
  countFrequency: string;
  kinesisVideoStream: kinesisvideo.CfnStream;
}

export class ECSResources extends Construct {
  fargateService: ApplicationLoadBalancedFargateService;
  applicationLoadBalancer: ApplicationLoadBalancer;
  kinesisRole: Role;

  constructor(scope: Construct, id: string, props: ECSResourcesProps) {
    super(scope, id);

    const kvsProducerRole = new Role(this, 'kvsProducerRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      inlinePolicies: {
        ['KinesisVideoPolicy']: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: [
                `arn:aws:kinesisvideo:${Stack.of(this).region}:${
                  Stack.of(this).account
                }:stream/ffmpeg-streaming/*`,
              ],
              actions: ['kinesisvideo:*'],
            }),
          ],
        }),
      },

      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });
    props.sourceBucket.grantRead(kvsProducerRole);

    this.kinesisRole = new Role(this, 'kinesisRole', {
      assumedBy: new CompositePrincipal(
        new ArnPrincipal(kvsProducerRole.roleArn),
        // new ArnPrincipal(`arn:aws:iam::${Stack.of(this).account}:user/*`),
        new AccountPrincipal(Stack.of(this).account),
      ),
      inlinePolicies: {
        ['KinesisVideoPolicy']: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: ['*'],
              actions: ['kinesisvideo:PutMedia'],
            }),
          ],
        }),
      },
    });

    kvsProducerRole.grantAssumeRole(
      new AccountPrincipal(Stack.of(this).account),
    );

    this.applicationLoadBalancer = new ApplicationLoadBalancer(
      this,
      'applicationLoadBalancer',
      {
        vpc: props.vpc,
        vpcSubnets: { subnetType: SubnetType.PUBLIC },
        internetFacing: false,
        securityGroup: props.kvsProducerAlbSecurityGroup,
      },
    );

    this.fargateService = new ApplicationLoadBalancedFargateService(
      this,
      'fargateService',
      {
        taskImageOptions: {
          image: ContainerImage.fromAsset('src/resources/kvsProducer'),
          taskRole: kvsProducerRole,
          environment: {
            SOURCE_BUCKET: props.sourceBucket.bucketName,
            COUNT_FREQUENCY: props.countFrequency,
            ECS_ROLE: this.kinesisRole.roleArn,
            ECS_LOGLEVEL: props.logLevel,
            KVS_STREAM_ARN: props.kinesisVideoStream.attrArn,
          },
        },
        publicLoadBalancer: true,
        cpu: 4096,
        memoryLimitMiB: 8192,
        vpc: props.vpc,
        assignPublicIp: true,
        openListener: false,
        loadBalancer: this.applicationLoadBalancer,
        listenerPort: 80,
        taskSubnets: {
          subnetType: SubnetType.PUBLIC,
        },
        securityGroups: [props.kvsProducerAlbSecurityGroup],
        runtimePlatform: {
          operatingSystemFamily: OperatingSystemFamily.LINUX,
          cpuArchitecture: CpuArchitecture.ARM64,
        },
      },
    );

    this.fargateService.service.connections.allowFrom(
      props.kvsProducerAlbSecurityGroup,
      Port.tcp(80),
    );
  }
}
