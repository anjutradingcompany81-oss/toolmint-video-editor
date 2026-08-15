import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException("Database is not reachable");
    }

    return {
      status: "ok",
      service: "toolmint-api",
      timestamp: new Date().toISOString(),
    };
  }
}
