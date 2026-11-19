import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

const storageSchema = z.object({
  S3_ENDPOINT: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

export function storageConfigured() {
  return storageSchema.safeParse(process.env).success;
}

function connection() {
  const result = storageSchema.safeParse(process.env);
  if (!result.success) throw new Error('Object storage is not configured.');
  const config = result.data;
  return {
    bucket: config.S3_BUCKET,
    client: new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
    }),
  };
}

export async function putObject(key: string, body: Uint8Array, contentType: string) {
  const { client, bucket } = connection();
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
      { abortSignal: AbortSignal.timeout(60_000) },
    );
  } finally {
    client.destroy();
  }
}

export async function getObject(key: string) {
  const { client, bucket } = connection();
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(60_000),
    });
    const body = await object.Body?.transformToByteArray();
    if (!body) return undefined;
    return { body, contentType: object.ContentType ?? undefined };
  } finally {
    client.destroy();
  }
}

export async function deleteObject(key: string) {
  const { client, bucket } = connection();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(15_000),
    });
  } finally {
    client.destroy();
  }
}

export async function putPicture(key: string, body: Uint8Array) {
  await putObject(key, body, 'image/webp');
}

export async function getPicture(key: string) {
  const object = await getObject(key);
  return object?.body;
}

export async function deletePicture(key: string) {
  await deleteObject(key);
}
