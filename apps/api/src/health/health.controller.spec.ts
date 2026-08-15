import { Test, TestingModule } from "@nestjs/testing";
import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { PrismaService } from "../prisma/prisma.service";

describe("HealthController", () => {
  let controller: HealthController;
  let prisma: { $queryRaw: jest.Mock };

  beforeEach(async () => {
    prisma = { $queryRaw: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();

    controller = module.get(HealthController);
  });

  it("reports ok when the database responds", async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);

    const result = await controller.check();

    expect(result.status).toBe("ok");
    expect(result.service).toBe("toolmint-api");
  });

  it("raises a 503 when the database is unreachable", async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error("connection refused"));

    await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
