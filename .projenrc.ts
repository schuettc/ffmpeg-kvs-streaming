const { awscdk } = require('projen');
const { JobPermission } = require('projen/lib/github/workflows-model');
const { UpgradeDependenciesSchedule } = require('projen/lib/javascript');

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: '2.118.0',
  license: 'MIT-0',
  author: 'Court Schuett',
  copyrightOwner: 'Court Schuett',
  authorAddress: 'https://subaud.io',
  appEntrypoint: 'ffmpeg-kvs-streaming.ts',
  jest: false,
  projenrcTs: true,
  depsUpgradeOptions: {
    ignoreProjen: false,
    workflowOptions: {
      labels: ['auto-approve', 'auto-merge'],
      schedule: UpgradeDependenciesSchedule.WEEKLY,
    },
  },
  autoApproveOptions: {
    secret: 'GITHUB_TOKEN',
    allowedUsernames: ['schuettc'],
  },
  autoApproveUpgrades: true,
  projenUpgradeSecret: 'PROJEN_GITHUB_TOKEN',
  defaultReleaseBranch: 'main',
  name: 'kvs-producer',
  devDeps: [],
  deps: [
    '@types/aws4',
    'aws4',
    'dotenv',
    'fs-extra',
    '@types/fs-extra',
    'aws-lambda',
    '@types/aws-lambda',
    'axios',
    '@aws-sdk/client-sts',
    '@aws-sdk/client-kinesis-video',
    '@aws-sdk/client-s3',
    'fastify',
    'fluent-ffmpeg',
    '@types/fluent-ffmpeg',
  ],
});

project.addTask('launch', {
  exec: 'yarn && yarn projen && yarn build && yarn cdk bootstrap && yarn cdk deploy  --require-approval never && yarn exportRole && yarn exportKvsArn',
});

project.addTask('exportRole', {
  exec: "echo ECS_ROLE=$( aws cloudformation describe-stacks --stack-name KVSStreaming --region us-east-1 --query 'Stacks[0].Outputs[?OutputKey==`ecsRole`].OutputValue' --output text ) >> ./src/resources/kvsProducer/.env",
});

project.addTask('exportKvsArn', {
  exec: "echo KVS_STREAM_ARN=$( aws cloudformation describe-stacks --stack-name KVSStreaming --region us-east-1 --query 'Stacks[0].Outputs[?OutputKey==`kvsArn`].OutputValue' --output text ) >> ./src/resources/kvsProducer/.env",
});

project.addTask('getExports', {
  exec: 'echo > ./src/resources/kvsProducer/.env && yarn exportRole && yarn exportKvsArn',
});

project.tsconfigDev.file.addOverride('include', [
  'src/**/*.ts',
  './.projenrc.ts',
]);

project.eslint.addOverride({
  files: ['site/src/**/*.tsx', 'src/resources/**/*.ts'],
  rules: {
    'indent': 'off',
    '@typescript-eslint/indent': 'off',
  },
});

const common_exclude = [
  'cdk.out',
  'cdk.context.json',
  'yarn-error.log',
  'dependabot.yml',
  '.DS_Store',
  '.env',
];

project.gitignore.exclude(...common_exclude);
project.synth();
