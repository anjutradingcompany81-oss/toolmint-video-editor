import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;
}
