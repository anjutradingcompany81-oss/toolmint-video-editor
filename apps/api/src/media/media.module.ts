import { Module } from "@nestjs/common";
import { ProjectsModule } from "../projects/projects.module";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";
import { MediaProbeService } from "./media-probe.service";

@Module({
  imports: [ProjectsModule],
  controllers: [MediaController],
  providers: [MediaService, MediaProbeService],
})
export class MediaModule {}
