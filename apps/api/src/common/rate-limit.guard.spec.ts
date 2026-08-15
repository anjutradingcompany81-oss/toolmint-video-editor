import { ExecutionContext, HttpException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RateLimitGuard } from "./rate-limit.guard";

function buildContext(ip: string, handler: () => void = function handler() {}) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ ip }) }),
    getHandler: () => handler,
    getClass: () => ({ name: "TestController" }),
  } as unknown as ExecutionContext;
}

describe("RateLimitGuard", () => {
  it("allows requests under the limit and blocks once it's exceeded", () => {
    const reflector = { get: jest.fn().mockReturnValue({ limit: 2, windowMs: 60_000 }) } as unknown as Reflector;
    const guard = new RateLimitGuard(reflector);
    const ctx = buildContext("1.2.3.4");

    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
  });

  it("tracks separate callers independently", () => {
    const reflector = { get: jest.fn().mockReturnValue({ limit: 1, windowMs: 60_000 }) } as unknown as Reflector;
    const guard = new RateLimitGuard(reflector);

    expect(guard.canActivate(buildContext("1.1.1.1"))).toBe(true);
    expect(guard.canActivate(buildContext("2.2.2.2"))).toBe(true);
  });

  it("passes through routes with no @RateLimit metadata", () => {
    const reflector = { get: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new RateLimitGuard(reflector);
    const ctx = buildContext("9.9.9.9");

    for (let i = 0; i < 50; i++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });
});
