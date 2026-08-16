import { createWriteStream } from "fs";
import { readFile } from "fs/promises";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DeleteObjectCommand, PutObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const DOWNLOAD_URL_TTL_SECONDS = 10 * 60;

// Talks to whatever's behind S3_ENDPOINT — MinIO locally, AWS S3 / R2 / B2 in
// production. Swapping providers is an env-var change, not a code change.
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = config.getOrThrow<string>("S3_BUCKET");
    this.client = new S3Client({
      endpoint: config.getOrThrow<string>("S3_ENDPOINT"),
      region: config.getOrThrow<string>("S3_REGION"),
      forcePathStyle: config.get<string>("S3_FORCE_PATH_STYLE", "false") === "true",
      credentials: {
        accessKeyId: config.getOrThrow<string>("S3_ACCESS_KEY_ID"),
        secretAccessKey: config.getOrThrow<string>("S3_SECRET_ACCESS_KEY"),
      },
    });
  }

  // Uploads are proxied through the API rather than a direct browser->bucket
  // presigned PUT, so this works identically on any S3-compatible backend
  // regardless of that bucket's CORS configuration.
  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async presignDownload(key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  // Render workers need a real local file for ffmpeg to read — streamed
  // straight to disk rather than buffered in memory, since source media can
  // be large.
  async downloadToFile(key: string, localPath: string): Promise<void> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error(`Object ${key} has no body`);
    await pipeline(result.Body as Readable, createWriteStream(localPath));
  }

  async putObjectFromFile(key: string, localPath: string, contentType: string): Promise<void> {
    const body = await readFile(localPath);
    await this.putObject(key, body, contentType);
  }
}
