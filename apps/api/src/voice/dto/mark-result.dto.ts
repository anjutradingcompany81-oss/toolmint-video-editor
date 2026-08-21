import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsEnum, IsOptional, IsString, MinLength, ValidateNested } from "class-validator";
import { CorrectionMode, RepetitionReviewStatus } from "@prisma/client";

export class MarkResultDto {
  @IsEnum(RepetitionReviewStatus)
  status!: RepetitionReviewStatus;

  // Required when status=APPLIED — which of the two correction modes the
  // user actually applied client-side (the composition edit itself
  // already happened via the normal PATCH /composition save, same as
  // every other timeline edit; this call is bookkeeping only, so the
  // review panel and "Correct All" summary reflect reality after a
  // refresh).
  @IsOptional()
  @IsEnum(CorrectionMode)
  appliedMode?: CorrectionMode;
}

export class BatchMarkResultEntryDto {
  @IsString()
  @MinLength(1)
  id!: string;

  @IsEnum(CorrectionMode)
  appliedMode!: CorrectionMode;
}

// One entry per result, each with its own appliedMode — a "Correct All
// High-Confidence" batch is rarely uniform (audio-only room-tone fixes
// mixed with audio+video ripple trims, depending on what each result's
// own suggestedMode was), so a single shared mode for the whole batch
// would mislabel whichever results didn't use it.
export class BatchMarkResultsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BatchMarkResultEntryDto)
  results!: BatchMarkResultEntryDto[];
}
