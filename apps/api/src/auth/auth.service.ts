import { randomBytes } from "crypto";
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import type { User } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { UsersService } from "../users/users.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { generateToken, hashToken, parseDurationMs } from "./tokens.util";
import { PublicUser, toPublicUser } from "./public-user";

const BCRYPT_ROUNDS = 12;
const EMAIL_VERIFICATION_TTL = "1d";
const PASSWORD_RESET_TTL = "1h";
const INVALID_CREDENTIALS = "Invalid email or password";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends AuthTokens {
  user: PublicUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) throw new ConflictException("An account with this email already exists");

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email: dto.email, passwordHash, displayName: dto.displayName },
      });
      const workspace = await tx.workspace.create({
        data: { name: `${dto.displayName}'s Workspace`, slug: buildWorkspaceSlug(dto.displayName) },
      });
      await tx.membership.create({
        data: { userId: created.id, workspaceId: workspace.id, role: "OWNER" },
      });
      return created;
    });

    await this.issueEmailVerification(user);
    const tokens = await this.issueTokenPair(user.id, user.email);
    return { user: toPublicUser(user), ...tokens };
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.users.findByEmail(dto.email);
    if (!user) throw new UnauthorizedException(INVALID_CREDENTIALS);

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException(INVALID_CREDENTIALS);

    const tokens = await this.issueTokenPair(user.id, user.email);
    return { user: toPublicUser(user), ...tokens };
  }

  async refresh(rawRefreshToken: string | undefined): Promise<AuthResult> {
    if (!rawRefreshToken) {
      // Test-instance-only escape hatch (see deploy/docker-compose.test.yml)
      // — never set on the real production stack. Lets a browser with no
      // session cookie land signed in automatically, so testers don't need
      // a real account.
      if (this.config.get<string>("DISABLE_AUTH") === "true") {
        const user = await this.getOrCreateTestUser();
        const tokens = await this.issueTokenPair(user.id, user.email);
        return { user: toPublicUser(user), ...tokens };
      }
      throw new UnauthorizedException("Missing refresh token");
    }

    const tokenHash = hashToken(rawRefreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored) throw new UnauthorizedException("Refresh token is invalid or expired");

    if (stored.revokedAt) {
      // The token was already rotated once — presenting it again means it
      // leaked. Kill every active session for this user, not just this one.
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException("Refresh token is invalid or expired");
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token is invalid or expired");
    }

    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });

    const user = await this.users.findById(stored.userId);
    if (!user) throw new UnauthorizedException("Refresh token is invalid or expired");

    const tokens = await this.issueTokenPair(user.id, user.email);
    return { user: toPublicUser(user), ...tokens };
  }

  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (!rawRefreshToken) return;
    const tokenHash = hashToken(rawRefreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException("Account not found");
    if (user.emailVerifiedAt) throw new BadRequestException("Email is already verified");
    await this.issueEmailVerification(user);
  }

  async verifyEmail(rawToken: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const stored = await this.prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
      throw new BadRequestException("Verification link is invalid or expired");
    }

    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({ where: { id: stored.userId }, data: { emailVerifiedAt: new Date() } }),
    ]);
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user) return; // Don't reveal whether an account exists for this email.

    const token = generateToken();
    const expiresAt = new Date(Date.now() + parseDurationMs(PASSWORD_RESET_TTL));
    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt },
    });

    const resetUrl = `${this.config.getOrThrow<string>("WEB_APP_URL")}/reset-password?token=${token}`;
    await this.mail.send({
      to: user.email,
      subject: "Reset your ToolMint password",
      text: `Reset your password: ${resetUrl}\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
    });
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    const stored = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
      throw new BadRequestException("Reset link is invalid or expired");
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({ where: { id: stored.userId }, data: { passwordHash } }),
      // A password reset invalidates every existing session, not just future ones.
      this.prisma.refreshToken.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  }

  refreshCookieTtlMs(): number {
    return parseDurationMs(this.config.get<string>("JWT_REFRESH_TTL", "30d"));
  }

  private async getOrCreateTestUser(): Promise<User> {
    const email = "test@toolmint.local";
    const existing = await this.users.findByEmail(email);
    if (existing) return existing;

    const passwordHash = await bcrypt.hash(randomBytes(24).toString("hex"), BCRYPT_ROUNDS);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, passwordHash, displayName: "Test User", emailVerifiedAt: new Date() },
      });
      const workspace = await tx.workspace.create({
        data: { name: "Test Workspace", slug: buildWorkspaceSlug("Test User") },
      });
      await tx.membership.create({
        data: { userId: created.id, workspaceId: workspace.id, role: "OWNER" },
      });
      return created;
    });
  }

  private async issueTokenPair(userId: string, email: string): Promise<AuthTokens> {
    // expiresIn takes seconds here (not the raw "15m" string) so it doesn't
    // depend on jsonwebtoken's stricter string-literal typing.
    const accessTokenTtlSeconds = Math.floor(parseDurationMs(this.config.get<string>("JWT_ACCESS_TTL", "15m")) / 1000);
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email },
      {
        secret: this.config.getOrThrow<string>("JWT_ACCESS_SECRET"),
        expiresIn: accessTokenTtlSeconds,
      },
    );

    const refreshToken = generateToken();
    const expiresAt = new Date(Date.now() + this.refreshCookieTtlMs());
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: hashToken(refreshToken), expiresAt },
    });

    return { accessToken, refreshToken };
  }

  private async issueEmailVerification(user: User): Promise<void> {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + parseDurationMs(EMAIL_VERIFICATION_TTL));
    await this.prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt },
    });

    const verifyUrl = `${this.config.getOrThrow<string>("WEB_APP_URL")}/verify-email?token=${token}`;
    await this.mail.send({
      to: user.email,
      subject: "Verify your ToolMint account",
      text: `Confirm your email: ${verifyUrl}\nThis link expires in 24 hours.`,
    });
  }
}

function buildWorkspaceSlug(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `${base || "workspace"}-${randomBytes(3).toString("hex")}`;
}
