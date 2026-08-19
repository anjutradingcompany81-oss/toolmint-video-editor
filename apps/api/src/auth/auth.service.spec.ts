import { BadRequestException, ConflictException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { AuthService } from "./auth.service";
import { hashToken } from "./tokens.util";
import type { MailService } from "../mail/mail.service";
import type { UsersService } from "../users/users.service";
import type { PrismaService } from "../prisma/prisma.service";

const CONFIG_VALUES: Record<string, string> = {
  JWT_ACCESS_SECRET: "test-secret",
  JWT_ACCESS_TTL: "15m",
  JWT_REFRESH_TTL: "30d",
  WEB_APP_URL: "http://localhost:3000",
};

interface PrismaMock {
  user: { create: jest.Mock; update: jest.Mock };
  workspace: { create: jest.Mock };
  membership: { create: jest.Mock };
  refreshToken: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  emailVerificationToken: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  passwordResetToken: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  $transaction: jest.Mock;
}

function buildPrismaMock(): PrismaMock {
  const prisma: PrismaMock = {
    user: { create: jest.fn(), update: jest.fn() },
    workspace: { create: jest.fn().mockResolvedValue({ id: "ws_1" }) },
    membership: { create: jest.fn().mockResolvedValue({}) },
    refreshToken: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    emailVerificationToken: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    passwordResetToken: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (tx: PrismaMock) => unknown)(prisma);
    return Promise.all(arg as Promise<unknown>[]);
  });
  return prisma;
}

function buildUser(overrides: Partial<{ id: string; email: string; passwordHash: string; emailVerifiedAt: Date | null }> = {}) {
  return {
    id: overrides.id ?? "user_1",
    email: overrides.email ?? "ada@example.com",
    passwordHash: overrides.passwordHash ?? bcrypt.hashSync("correct-horse-battery", 4),
    displayName: "Ada Lovelace",
    emailVerifiedAt: overrides.emailVerifiedAt ?? null,
    isGuest: false,
    mfaEnabled: false,
    mfaSecret: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("AuthService", () => {
  let prisma: ReturnType<typeof buildPrismaMock>;
  let users: jest.Mocked<Pick<UsersService, "findByEmail" | "findById">>;
  let mail: jest.Mocked<MailService>;
  let service: AuthService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    users = { findByEmail: jest.fn(), findById: jest.fn() };
    mail = { send: jest.fn().mockResolvedValue(undefined) };
    const config = new ConfigService(CONFIG_VALUES);
    const jwt = new JwtService({});

    service = new AuthService(prisma as unknown as PrismaService, users as unknown as UsersService, jwt, config, mail);
  });

  describe("register", () => {
    it("creates a user with a default workspace and issues tokens", async () => {
      users.findByEmail.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue(buildUser({ email: "new@example.com" }));

      const result = await service.register({ email: "new@example.com", password: "correct-horse-battery", displayName: "Ada Lovelace" });

      expect(prisma.workspace.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: "Ada Lovelace's Workspace" }) }),
      );
      expect(prisma.membership.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: "OWNER" }) }));
      expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: "new@example.com", subject: expect.stringContaining("Verify") }));
      expect(result.user.email).toBe("new@example.com");
      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.refreshToken).toEqual(expect.any(String));
    });

    it("rejects a duplicate email", async () => {
      users.findByEmail.mockResolvedValue(buildUser());

      await expect(
        service.register({ email: "ada@example.com", password: "correct-horse-battery", displayName: "Ada" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe("login", () => {
    it("issues tokens for a correct password", async () => {
      users.findByEmail.mockResolvedValue(buildUser());

      const result = await service.login({ email: "ada@example.com", password: "correct-horse-battery" });

      expect(result.user.email).toBe("ada@example.com");
      expect(result.accessToken).toEqual(expect.any(String));
      expect(prisma.refreshToken.create).toHaveBeenCalled();
    });

    it("rejects an unknown email without revealing that it's unknown", async () => {
      users.findByEmail.mockResolvedValue(null);

      await expect(service.login({ email: "nobody@example.com", password: "whatever1" })).rejects.toMatchObject({
        message: "Invalid email or password",
      });
    });

    it("rejects an incorrect password with the same message as an unknown email", async () => {
      users.findByEmail.mockResolvedValue(buildUser());

      await expect(service.login({ email: "ada@example.com", password: "wrong-password" })).rejects.toMatchObject({
        message: "Invalid email or password",
      });
    });
  });

  describe("refresh", () => {
    it("rotates a valid refresh token", async () => {
      const raw = "raw-refresh-token";
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: "rt_1",
        userId: "user_1",
        tokenHash: hashToken(raw),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      users.findById.mockResolvedValue(buildUser());

      const result = await service.refresh(raw);

      expect(prisma.refreshToken.update).toHaveBeenCalledWith({ where: { id: "rt_1" }, data: { revokedAt: expect.any(Date) } });
      expect(result.refreshToken).not.toBe(raw);
    });

    it("throws when no token is presented", async () => {
      await expect(service.refresh(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("throws on an expired token", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: "rt_1",
        userId: "user_1",
        tokenHash: hashToken("expired"),
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.refresh("expired")).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("revokes every active session when a already-rotated token is replayed", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: "rt_1",
        userId: "user_1",
        tokenHash: hashToken("reused"),
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(service.refresh("reused")).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: "user_1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe("verifyEmail", () => {
    it("marks the user verified for a valid token", async () => {
      prisma.emailVerificationToken.findUnique.mockResolvedValue({
        id: "evt_1",
        userId: "user_1",
        tokenHash: hashToken("verify-me"),
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await service.verifyEmail("verify-me");

      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "user_1" }, data: { emailVerifiedAt: expect.any(Date) } });
    });

    it("rejects an already-used token", async () => {
      prisma.emailVerificationToken.findUnique.mockResolvedValue({
        id: "evt_1",
        userId: "user_1",
        tokenHash: hashToken("used"),
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(service.verifyEmail("used")).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("forgotPassword / resetPassword", () => {
    it("stays silent for an unknown email", async () => {
      users.findByEmail.mockResolvedValue(null);

      await service.forgotPassword("nobody@example.com");

      expect(mail.send).not.toHaveBeenCalled();
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    });

    it("issues a reset token for a known email", async () => {
      users.findByEmail.mockResolvedValue(buildUser());

      await service.forgotPassword("ada@example.com");

      expect(prisma.passwordResetToken.create).toHaveBeenCalled();
      expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@example.com" }));
    });

    it("resets the password and revokes existing sessions for a valid token", async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: "prt_1",
        userId: "user_1",
        tokenHash: hashToken("reset-me"),
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await service.resetPassword("reset-me", "new-correct-horse");

      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "user_1" }, data: { passwordHash: expect.any(String) } });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: "user_1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it("rejects an expired reset token", async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: "prt_1",
        userId: "user_1",
        tokenHash: hashToken("expired"),
        usedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.resetPassword("expired", "new-correct-horse")).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
