import type { User } from "@prisma/client";

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  emailVerifiedAt: Date | null;
  isGuest: boolean;
}

// Never let a full Prisma User (passwordHash, mfaSecret, ...) reach a response body.
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerifiedAt: user.emailVerifiedAt,
    isGuest: user.isGuest,
  };
}
