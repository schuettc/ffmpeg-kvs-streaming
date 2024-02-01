# ffmpeg streaming to KVS

[Amazon Kinesis Video Streams](https://aws.amazon.com/kinesis/video-streams) can be used to get access to other AWS services with streaming video. In this demo, we will see how to use [Node.js](https://nodejs.org/en) and [ffmpeg](https://ffmpeg.org/) to convert a file into a stream that can be sent to KVS.

![Overview](/images/ffmpegStreaming.png)

1. An object is created in the Amazon Simple Storage Service (Amazon S3) bucket. When this happens, a notification is sent to the associated AWS Lambda function.
2. This Lambda makes a request to the [Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html) associated with the [AWS Fargate](https://aws.amazon.com/fargate/) task with the object information.
3. The Fargate application downloads the object from S3 and begins processing (processing details below).
4. The Fargate application streams the contents of the object to [Amazon Kinesis Video Streams](https://aws.amazon.com/kinesis/video-streams/).

## Processing with ffmpeg

Once the file has been downloaded from S3, the application will begin processing the file with ffmpeg.

```typescript
async function processFfmpeg(fileName: string): Promise<{
  videoStream: PassThrough;
}> {
  console.log('Processing with ffmpeg');
  const videoStream = new PassThrough();
  let videStreamCount: number = 0;

  ffmpeg(fileName)
    .native()
    .output(videoStream)
    .outputOptions(['-profile:v baseline'])
    .videoCodec('libx264')
    .size('640x480')
    .audioCodec('aac')
    .format('matroska')
    .on('error', (error) => {
      console.log('Cannot process: ' + error.message);
    })
    .on('stderr', (data) => {
      if (videStreamCount % COUNT_FREQUENCY === 0) {
        console.info(`videoStream: ${data}`);
      }
      videStreamCount++;
    })
    .run();

  return { videoStream };
}
```

To do this, we will create a `PassThrough` stream that will be used as the output of the ffmpeg pipe. By using `.native()` as an input option, the ffmpeg pipe will read the contents of the file at the native frame rate. The output options used will format the output stream so that it can be used by KVS.

## Streaming Media

Because Kinesis Video Streams [PutMedia](https://docs.aws.amazon.com/kinesisvideostreams/latest/dg/API_dataplane_PutMedia.html) does not have a corresponding AWS SDK command, we must use a direct HTTP request. This involves several extra steps:

1. GetDataEndpoint
2. GetCredentials
3. SignRequest
4. PutMedia

### GetDataEndpoint

```typescript
async function getEndpoint(
  streamArn: string,
): Promise<GetDataEndpointCommandOutput['DataEndpoint']> {
  const response = await kvsClient.send(
    new GetDataEndpointCommand({
      APIName: APIName.PUT_MEDIA,
      StreamARN: streamArn,
    }),
  );
  return response.DataEndpoint;
}
```

The first step to sending a stream to KVS is to get an endpoint for the stream we are going to use. We have already created the stream during the deployment of the CDK, so we will use that stream as the target.

### GetCredentials

```typescript
const ECS_ROLE = process.env.ECS_ROLE || '';

async function getCredentials(): Promise<
  AssumeRoleCommandOutput['Credentials']
> {
  console.log('Getting credentials');
  const response = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: ECS_ROLE,
      RoleSessionName: 'kvs-stream',
    }),
  );
  return response.Credentials;
}
```

In order to stream to the KVS, we will need to assume an IAM role that has permission to do this. More details about doing this using a local Docker are outlined below.

#### IAM Role

```typescript
this.kinesisRole = new Role(this, 'kinesisRole', {
  assumedBy: new CompositePrincipal(
    new ArnPrincipal(kvsProducerRole.roleArn),
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
```

During the deployment of the CDK, an [IAM Role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html) is created. This is the role that we will assume and use to `PutMedia`. This Role is passed to the application through environment variables.

### SignRequest

```typescript
async function signRequest(
  streamArn: string,
  endpoint: string,
): Promise<{ signedUrl: aws4.Request; reqUrl: string }> {
  const credentials = await getCredentials();
  if (!credentials) {
    throw new Error('Failed to get credentials');
  }
  const signedUrl = aws4.sign(
    {
      host: endpoint,
      path: '/putMedia',
      service: 'kinesisvideo',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-amzn-stream-arn': streamArn,
        'x-amzn-fragment-timecode-type': 'ABSOLUTE',
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
    },
    {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  );
  if (!signedUrl || !signedUrl.host || !signedUrl.path) {
    throw new Error('Failed to sign request');
  }
  const reqUrl = signedUrl.host + signedUrl.path;
  return { signedUrl: signedUrl, reqUrl: reqUrl };
}
```

Using the credentials from the assumed role, the Stream ARN, and the DataEndpoint, we will use [aws4](https://github.com/mhart/aws4) to sign the request we will be making and get a URL to use in the `PutMedia`.

### PutMedia

```typescript
const agent = new Agent({
  rejectUnauthorized: false,
});
const axiosParams = {
  method: 'POST',
  timeout: 40 * 1000,
  url: reqUrl,
  headers: signedUrl.headers as AxiosHeaders,
  data: stream,
  responseType: 'stream' as ResponseType,
  maxContentLength: Infinity,
  httpsAgent: agent,
};
```

Next, we will combine all of the pieces together as we prepare to `PutMedia`. Using the stream generated by `ffmpeg` and the url generated by `aws4`, we will create a `POST` request using [axios](https://axios-http.com/docs/intro).

```typescript
let streamCount: number = 0;

try {
  const response = (await axios(axiosParams)) as AxiosResponse;
  const startFragmentNumber = await getStartFragmentNumber(response);

  response.data.on('data', (chunk: Buffer) => {
    if (streamCount % COUNT_FREQUENCY === 0) {
      console.info(`Stream: ${streamArn} - Chunk: ${chunk.toString()}`);
    }
    streamCount++;
  });
  response.data.on('end', async () => {
    console.log(`Stream: ${streamArn} ended`);
  });

  response.data.on('error', (error: Error) => {
    console.error(`Error in ${streamArn} stream: ${error}`);
  });
  if (startFragmentNumber) {
    return { streamArn, startFragmentNumber };
  } else {
    throw new Error('StartFragment not found');
  }
} catch (error) {
  console.error('Error in putMedia:', error);
  throw error;
}
```

Finally, we will make the `POST` request to the `PutMedia` API and process the responses. For every fragment sent, KVS will acknowledge with a response:

```json
{
       Acknowledgement : {
          "EventType": enum
          "FragmentTimecode": Long,
          "FragmentNumber": Long,
          "ErrorId" : String
      }
}
```

## Testing

In order to test this demo, you can upload a movie file to the S3 bucket that is created during the CDK deployment. This will start processing on the Fargate container and streaming to KVS. This stream can be seen in the [KVS Console](https://us-east-1.console.aws.amazon.com/kinesisvideo/home?region=us-east-1#/streams) and finding the stream named `ffmpeg-streaming`.

![KVSConsole](/images/KVS.png)

This stream can be viewed with `Media playback`.

![MediaPlayback](/images/MediaPlayback.png)

## Developing Locally with Docker

Because development like this can require extensive trial and error testing, it is useful to test locally with a Docker image before deploying to Fargate. This will involve several steps:

1. Build a local Docker container
2. Pass credentials and environment variables to this container
3. Run the local Docker container
4. Trigger this container

### Build the Docker container

To do this, we will use [Docker Compose](https://docs.docker.com/compose/) and a `.env` file.

```docker-compose
version: '3'
services:
  ffmpeg:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - AWS_PROFILE
      - AWS_ACCESS_KEY_ID
      - AWS_SECRET_ACCESS_KEY
      - AWS_SESSION_TOKEN
      - COUNT_FREQUENCY=60
      - ECS_ROLE
      - KVS_STREAM_ARN
    volumes:
      - ~/.aws/:/root/.aws:ro
    ports:
      - '80:80'
    command: ['npm', 'start']
```

### Pass credentials and environment variables

This will use the `Dockerfile` used in the deployment with environment variables and a mounted volume that references `./aws`. This will allow us to pass credentials from the [`.aws/credentials`](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html) file and use the associated `AWS_PROFILE`.

Alternatively, you can export `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` as environment variables.

`ECS_ROLE` and `KVS_STREAM_ARN` are created during the deployment of the CDK and passed to the `.env` file through the outputs of the CDK.

### Run the Docker container

To run the Docker container:

```bash
docker-compose up --build
```

This will re-build and run the Docker container

### Trigger the Docker container

[Postman](https://www.postman.com/) is a useful tool for making API request. This is similar to what we will be doing with the Lambda function and serves as a convenient way to test locally. The Docker container will be running on port 80, so we will make a `POST` request to `localhost:80/processObject` passing the `bucketName` and `keyName` of the object to be processed.

![Postman](/images/Postman.png)

## Using this demo

### Requirements

- yarn installed
- ARM processor
- Docker desktop running

### Deploy

```bash
yarn launch
```

### Cleanup

```bash
yarn cdk destroy
```
