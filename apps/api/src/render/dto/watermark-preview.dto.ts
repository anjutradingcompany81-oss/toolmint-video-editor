import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsInt, IsString, Min, MinLength, ValidateNested } from "class-validator";

export class WatermarkRegionDto {
  @IsString()
  @MinLength(1)
  id!: string;

  @IsInt()
  @Min(0)
  x!: number;

  @IsInt()
  @Min(0)
  y!: number;

  @IsInt()
  @Min(1)
  width!: number;

  @IsInt()
  @Min(1)
  height!: number;
}

export class WatermarkPreviewDto {
  @IsInt()
  @Min(0)
  timeMs!: number;

  @IsArray()
  // Each region is another delogo pass over the frame; a bounded list
  // keeps one request from turning into an unbounded filter chain.
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => WatermarkRegionDto)
  regions!: WatermarkRegionDto[];
}
