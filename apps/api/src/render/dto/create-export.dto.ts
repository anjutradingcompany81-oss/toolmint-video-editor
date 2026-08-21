import { ExportQuality, ExportResolution } from "@prisma/client";
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateExportDto {
  @IsEnum(ExportResolution)
  resolution!: ExportResolution;

  @IsOptional()
  @IsEnum(ExportQuality)
  quality?: ExportQuality;

  // User-chosen download filename — sanitized server-side before ever
  // touching a path or shell command, never trusted as-is.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  outputFileName?: string;
}
