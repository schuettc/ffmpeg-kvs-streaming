import { aws_kinesisvideo as kinesisvideo } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class KinesisResources extends Construct {
  public kinesisVideoStream: kinesisvideo.CfnStream;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.kinesisVideoStream = new kinesisvideo.CfnStream(
      this,
      'KinesisVideoStream',
      {
        dataRetentionInHours: 24,
        name: 'ffmpeg-streaming',
      },
    );
  }
}
