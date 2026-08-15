import { Module } from "@nestjs/common";
import { ProjectsModule } from "../projects/projects.module";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";

@Module({
  imports: [ProjectsModule],
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
