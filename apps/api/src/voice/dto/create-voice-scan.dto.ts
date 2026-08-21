import { Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength, ValidateNested } from "class-validator";
import { SensitivityPreset, VoiceScanScope } from "@prisma/client";

export class CustomThresholdsDto {
  @IsInt()
  @Min(0)
  @Max(100)
  transcriptSimilarityPct!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  audioSimilarityPct!: number;

  @IsInt()
  @Min(0)
  maxGapMs!: number;

  @IsInt()
  @Min(0)
  minSegmentDurationMs!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  confidenceThreshold!: number; // 0-100, converted to 0-1 before reaching the detector
}

export class CreateVoiceScanDto {
  @IsEnum(VoiceScanScope)
  scope!: VoiceScanScope;

  // Required (and validated against the project's current timeline) when
  // scope is CLIP; ignored for TIMELINE, which scans every video/audio
  // clip on the project's latest saved version.
  @IsOptional()
  @IsString()
  @MinLength(1)
  trackId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  clipId?: string;

  @IsOptional()
  @IsEnum(SensitivityPreset)
  sensitivityPreset?: SensitivityPreset;

  @IsOptional()
  @ValidateNested()
  @Type(() => CustomThresholdsDto)
  customThresholds?: CustomThresholdsDto;
}
