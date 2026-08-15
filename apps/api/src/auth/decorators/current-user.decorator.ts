import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { PublicUser } from "../public-user";

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): PublicUser => {
  const request = ctx.switchToHttp().getRequest<Request & { user: PublicUser }>();
  return request.user;
});
