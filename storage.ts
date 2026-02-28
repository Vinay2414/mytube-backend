import AWS from 'aws-sdk';
import { Client as MinioClient } from 'minio';
import fs from 'fs';
import path from 'path';

export class StorageService {
  private s3?: AWS.S3;
  private minio?: MinioClient;
  private useS3: boolean;
  private useMinio: boolean;

  constructor() {
    this.useS3 = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.S3_BUCKET);
    this.useMinio = !!(process.env.MINIO_ENDPOINT && process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY);

    if (this.useS3) {
      this.s3 = new AWS.S3({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION || 'us-east-1'
      });
      console.log('☁️ S3 storage configured');
    }

    if (this.useMinio) {
      this.minio = new MinioClient({
        endPoint: process.env.MINIO_ENDPOINT!,
        port: parseInt(process.env.MINIO_PORT || '9000'),
        useSSL: process.env.MINIO_USE_SSL === 'true',
        accessKey: process.env.MINIO_ACCESS_KEY!,
        secretKey: process.env.MINIO_SECRET_KEY!
      });
      console.log('☁️ MinIO storage configured');
    }

    if (!this.useS3 && !this.useMinio) {
      console.log('💾 Using local storage only');
    }
  }

  async uploadRecording(localPath: string, streamId: string): Promise<string | null> {
    if (!fs.existsSync(localPath)) {
      throw new Error('Recording file not found');
    }

    const fileName = `recordings/${streamId}/${path.basename(localPath)}`;

    try {
      if (this.useS3 && this.s3) {
        const fileStream = fs.createReadStream(localPath);
        
        const uploadParams = {
          Bucket: process.env.S3_BUCKET!,
          Key: fileName,
          Body: fileStream,
          ContentType: 'video/mp4',
          ACL: 'public-read'
        };

        const result = await this.s3.upload(uploadParams).promise();
        console.log(`☁️ Uploaded to S3: ${result.Location}`);
        return result.Location;
      }

      if (this.useMinio && this.minio) {
        const bucketName = process.env.MINIO_BUCKET || 'livestreams';
        
        // Ensure bucket exists
        const bucketExists = await this.minio.bucketExists(bucketName);
        if (!bucketExists) {
          await this.minio.makeBucket(bucketName);
        }

        await this.minio.fPutObject(bucketName, fileName, localPath, {
          'Content-Type': 'video/mp4'
        });

        const url = `${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT || 9000}/${bucketName}/${fileName}`;
        console.log(`☁️ Uploaded to MinIO: ${url}`);
        return url;
      }

      return null;
    } catch (error) {
      console.error('❌ Upload failed:', error);
      throw error;
    }
  }

  async uploadThumbnail(localPath: string, streamId: string): Promise<string | null> {
    if (!fs.existsSync(localPath)) {
      return null;
    }

    const fileName = `thumbnails/${streamId}/${path.basename(localPath)}`;

    try {
      if (this.useS3 && this.s3) {
        const fileStream = fs.createReadStream(localPath);
        
        const uploadParams = {
          Bucket: process.env.S3_BUCKET!,
          Key: fileName,
          Body: fileStream,
          ContentType: 'image/jpeg',
          ACL: 'public-read'
        };

        const result = await this.s3.upload(uploadParams).promise();
        return result.Location;
      }

      if (this.useMinio && this.minio) {
        const bucketName = process.env.MINIO_BUCKET || 'livestreams';
        
        await this.minio.fPutObject(bucketName, fileName, localPath, {
          'Content-Type': 'image/jpeg'
        });

        return `${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT || 9000}/${bucketName}/${fileName}`;
      }

      return null;
    } catch (error) {
      console.error('❌ Thumbnail upload failed:', error);
      return null;
    }
  }

  async deleteFile(cloudUrl: string): Promise<void> {
    try {
      if (this.useS3 && this.s3 && cloudUrl.includes('amazonaws.com')) {
        const key = cloudUrl.split('/').slice(-2).join('/');
        await this.s3.deleteObject({
          Bucket: process.env.S3_BUCKET!,
          Key: key
        }).promise();
        console.log(`🗑️ Deleted from S3: ${key}`);
      }

      if (this.useMinio && this.minio && cloudUrl.includes(process.env.MINIO_ENDPOINT!)) {
        const bucketName = process.env.MINIO_BUCKET || 'livestreams';
        const objectName = cloudUrl.split('/').slice(-2).join('/');
        await this.minio.removeObject(bucketName, objectName);
        console.log(`🗑️ Deleted from MinIO: ${objectName}`);
      }
    } catch (error) {
      console.error('❌ Failed to delete cloud file:', error);
    }
  }
}