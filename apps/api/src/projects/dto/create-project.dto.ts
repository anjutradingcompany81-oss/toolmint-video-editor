import { IsInt, IsOptional, IsPositive, IsString, MaxLength, MinLength } from "class-validator";

export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  fps?: number;

  // Which workspace to create the project in. Defaults to the caller's
  // (currently only) workspace until team workspaces exist.
  @IsOptional()
  @IsString()
  workspaceId?: string;
}
