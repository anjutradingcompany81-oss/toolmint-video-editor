import { ExportResolution } from "@prisma/client";
import { IsEnum, IsString, MinLength } from "class-validator";

export class CreateExportDto {
  @IsString()
  @MinLength(1)
  sceneId!: string;

  @IsEnum(ExportResolution)
  resolution!: ExportResolution;
}
