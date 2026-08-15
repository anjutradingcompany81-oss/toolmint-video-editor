import { Module } from "@nestjs/common";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";
import { CompositionController } from "./composition.controller";
import { CompositionService } from "./composition.service";

@Module({
  controllers: [ProjectsController, CompositionController],
  providers: [ProjectsService, CompositionService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
