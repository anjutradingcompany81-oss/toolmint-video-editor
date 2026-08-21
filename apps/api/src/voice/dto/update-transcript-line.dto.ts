import { IsInt, IsString, IsUUID, Min } from "class-validator";

export class UpdateTranscriptLineDto {
  @IsUUID()
  mediaAssetId!: string;

  // Source-local (asset-relative) chunk start ms — see MediaAsset.transcriptEdits.
  @IsInt()
  @Min(0)
  sourceStartMs!: number;

  @IsString()
  text!: string;
}
