import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PublicUser } from "../auth/public-user";
import { CreateProjectDto } from "./dto/create-project.dto";
import { UpdateProjectDto } from "./dto/update-project.dto";
import { ProjectsService } from "./projects.service";

const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

@UseGuards(JwtAuthGuard)
@Controller("projects")
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  create(@CurrentUser() user: PublicUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: PublicUser, @Query("includeArchived") includeArchived?: string, @Query("search") search?: string) {
    return this.projects.list(user.id, { includeArchived: includeArchived === "true", search });
  }

  @Get(":id")
  findOne(@CurrentUser() user: PublicUser, @Param("id") id: string) {
    return this.projects.findOne(user.id, id);
  }

  @Patch(":id")
  update(@CurrentUser() user: PublicUser, @Param("id") id: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(user.id, id, dto);
  }

  // Fed by the editor's own preview canvas (see scene-preview.tsx's
  // captureFrame) — a real frame of the actual project, not a placeholder.
  @Post(":id/thumbnail")
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: THUMBNAIL_MAX_BYTES } }))
  setThumbnail(@CurrentUser() user: PublicUser, @Param("id") id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException("No file was uploaded");
    return this.projects.setThumbnail(user.id, id, file.buffer, file.mimetype);
  }

  @HttpCode(201)
  @Post(":id/duplicate")
  duplicate(@CurrentUser() user: PublicUser, @Param("id") id: string) {
    return this.projects.duplicate(user.id, id);
  }

  @HttpCode(204)
  @Delete(":id")
  async remove(@CurrentUser() user: PublicUser, @Param("id") id: string) {
    await this.projects.remove(user.id, id);
  }
}
