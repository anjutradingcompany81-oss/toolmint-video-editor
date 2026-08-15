import { BadRequestException, Controller, Delete, Get, HttpCode, Param, Post, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PublicUser } from "../auth/public-user";
import { MAX_UPLOAD_BYTES } from "./media.constants";
import { MediaService } from "./media.service";

@UseGuards(JwtAuthGuard)
@Controller("projects/:projectId/media")
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post()
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file was uploaded");
    return this.media.upload(user.id, projectId, file);
  }

  @Get()
  list(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string) {
    return this.media.list(user.id, projectId);
  }

  @HttpCode(204)
  @Delete(":mediaAssetId")
  async remove(@CurrentUser() user: PublicUser, @Param("projectId") projectId: string, @Param("mediaAssetId") mediaAssetId: string) {
    await this.media.remove(user.id, projectId, mediaAssetId);
  }
}
