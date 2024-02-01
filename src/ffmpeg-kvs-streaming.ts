import { App, CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { config } from 'dotenv';
import {
  ECSResources,
  VPCResources,
  S3Resources,
  LambdaResources,
  KinesisResources,
} from '.';
config();

interface KVSProducerProps extends StackProps {
  logLevel: string;
  countFrequency: string;
}

export class KVSStreaming extends Stack {
  constructor(scope: Construct, id: string, props: KVSProducerProps) {
    super(scope, id, props);

    const s3Resources = new S3Resources(this, 'S3Resources');
    const vpcResources = new VPCResources(this, 'VPCResources');
    const kinesisResources = new KinesisResources(this, 'KinesisResources');
    const ecsResources = new ECSResources(this, 'ECSResources', {
      vpc: vpcResources.vpc,
      sourceBucket: s3Resources.sourceBucket,
      logLevel: props.logLevel,
      countFrequency: props.countFrequency,
      kvsProducerAlbSecurityGroup:
        vpcResources.applicationLoadBalancerSecurityGroup,
      kinesisVideoStream: kinesisResources.kinesisVideoStream,
    });

    new LambdaResources(this, 'LambdaResources', {
      sourceBucket: s3Resources.sourceBucket,
      applicationLoadBalancer: ecsResources.applicationLoadBalancer,
      applicationLoadBalancerSecurityGroup:
        vpcResources.applicationLoadBalancerSecurityGroup,
      vpc: vpcResources.vpc,
    });

    new CfnOutput(this, 'ecsRole', {
      value: ecsResources.kinesisRole.roleArn,
    });

    new CfnOutput(this, 'kvsArn', {
      value: kinesisResources.kinesisVideoStream.attrArn,
    });
  }
}

const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const stackProps = {
  logLevel: process.env.LOG_LEVEL || 'INFO',
  countFrequency: process.env.COUNT_FREQUENCY || '30',
};

const app = new App();

new KVSStreaming(app, 'KVSStreaming', {
  ...stackProps,
  env: devEnv,
});

app.synth();
