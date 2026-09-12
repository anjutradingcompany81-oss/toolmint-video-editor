import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from "class-validator";

// One spoken line. `startMs` is a timeline position rather than an offset
// into any particular clip, so rewriting dialogue survives the user
// cutting, splitting or moving the footage underneath it.
export class VoiceOverLineDto {
  @IsString()
  @MinLength(1)
  id!: string;

  @IsInt()
  @Min(0)
  startMs!: number;

  // Long enough for a real paragraph of narration, bounded so a single
  // line can't become an unbounded synthesis request.
  @IsString()
  @MaxLength(2000)
  text!: string;

  @IsString()
  @MinLength(1)
  voiceId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  speakerLabel?: string;
}

export class SaveVoiceOverScriptDto {
  @IsOptional()
  @IsString()
  providerId?: string;

  @IsArray()
  // A ceiling on lines per script - past this the synthesis queue time is
  // the real problem, and an unbounded array is a denial-of-service shape.
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => VoiceOverLineDto)
  lines!: VoiceOverLineDto[];
}

export class GenerateVoiceOverDto {
  @IsString()
  @MinLength(1)
  providerId!: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => VoiceOverLineDto)
  lines!: VoiceOverLineDto[];
}

export class GenerateScriptDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  prompt!: string;

  // How long the finished narration should run — the caller's timeline
  // duration, so a video-length script actually fits the video instead of
  // running short or spilling past the end.
  @IsInt()
  @Min(1000)
  targetDurationMs!: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  language?: string;
}
