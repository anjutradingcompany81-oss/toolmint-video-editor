import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { Prisma, VoiceOverJob, VoiceOverStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ProjectsService } from "../projects/projects.service";
import { GenerateVoiceOverDto, SaveVoiceOverScriptDto, VoiceOverLineDto } from "./dto/voice-over.dto";
import { TtsRegistryService } from "./tts/tts-registry.service";
import type { TtsProviderStatus } from "./tts/tts-provider";
import { VOICE_OVER_QUEUE } from "./voice-over.constants";
import type { LineTiming } from "./voice-over-mix.util";

const ACTIVE_STATUSES: VoiceOverStatus[] = [VoiceOverStatus.QUEUED, VoiceOverStatus.SYNTHESIZING, VoiceOverStatus.MIXING];

export interface VoiceOverScriptResponse {
  providerId: string | null;
  lines: VoiceOverLineDto[];
  updatedAt: string | null;
}

export interface VoiceOverJobResponse extends Omit<VoiceOverJob, "lines" | "lineTimings"> {
  lines: VoiceOverLineDto[];
  lineTimings: LineTiming[] | null;
}

@Injectable()
export class VoiceOverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly registry: TtsRegistryService,
    @Inject(VOICE_OVER_QUEUE) private readonly queue: Queue<{ voiceOverJobId: string }>,
  ) {}

  providers(): Promise<TtsProviderStatus[]> {
    return this.registry.statuses();
  }

  async getScript(userId: string, projectId: string): Promise<VoiceOverScriptResponse> {
    await this.projects.findOne(userId, projectId);
    const script = await this.prisma.voiceOverScript.findUnique({ where: { projectId } });
    if (!script) return { providerId: null, lines: [], updatedAt: null };
    return {
      providerId: script.providerId,
      lines: script.lines as unknown as VoiceOverLineDto[],
      updatedAt: script.updatedAt.toISOString(),
    };
  }

  async saveScript(userId: string, projectId: string, dto: SaveVoiceOverScriptDto): Promise<VoiceOverScriptResponse> {
    await this.projects.ensureEditable(userId, projectId);
    this.assertUniqueLineIds(dto.lines);

    const lines = dto.lines as unknown as Prisma.InputJsonValue;
    const script = await this.prisma.voiceOverScript.upsert({
      where: { projectId },
      create: { projectId, providerId: dto.providerId ?? null, lines },
      update: { providerId: dto.providerId ?? null, lines },
    });
    return {
      providerId: script.providerId,
      lines: script.lines as unknown as VoiceOverLineDto[],
      updatedAt: script.updatedAt.toISOString(),
    };
  }

  async generate(userId: string, projectId: string, dto: GenerateVoiceOverDto): Promise<VoiceOverJobResponse> {
    await this.projects.ensureEditable(userId, projectId);

    const speakable = dto.lines.filter((line) => line.text.trim().length > 0);
    if (speakable.length === 0) {
      throw new BadRequestException("Write at least one line of dialogue before generating a voice over");
    }
    this.assertUniqueLineIds(speakable);

    // Refuse up front on a provider that cannot run, naming the setting
    // that is missing. Falling back to a different provider would put a
    // voice the user did not choose into their video and still report
    // success.
    const provider = this.registry.get(dto.providerId);
    if (!provider) throw new BadRequestException(`Unknown voice provider "${dto.providerId}"`);
    if (provider.readiness() !== "READY") {
      throw new BadRequestException(
        `${provider.label} is not configured on this server${provider.requiredEnvVar ? ` — ${provider.requiredEnvVar} is not set` : ""}. Pick a provider marked ready, or ask an administrator to configure this one.`,
      );
    }

    const voices = await provider.listVoices();
    // Only enforced when the provider actually returned a list; an empty
    // list means the lookup failed, and rejecting the whole job over a
    // transient listing error would be worse than attempting synthesis.
    if (voices.length > 0) {
      const unknown = speakable.find((line) => !voices.some((v) => v.id === line.voiceId));
      if (unknown) throw new BadRequestException(`"${unknown.voiceId}" is not a voice offered by ${provider.label}`);
    }

    const active = await this.prisma.voiceOverJob.findFirst({ where: { projectId, status: { in: ACTIVE_STATUSES } } });
    if (active) throw new BadRequestException("A voice over is already being generated for this project");

    const job = await this.prisma.voiceOverJob.create({
      data: {
        projectId,
        providerId: dto.providerId,
        lines: speakable as unknown as Prisma.InputJsonValue,
        requestedById: userId,
        stageLabel: "Waiting to start",
      },
    });

    await this.queue.add("generate-voice-over", { voiceOverJobId: job.id }, { removeOnComplete: true, removeOnFail: false });
    return this.toResponse(job);
  }

  async list(userId: string, projectId: string): Promise<VoiceOverJobResponse[]> {
    await this.projects.findOne(userId, projectId);
    const jobs = await this.prisma.voiceOverJob.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 20 });
    return jobs.map((job) => this.toResponse(job));
  }

  async get(userId: string, projectId: string, jobId: string): Promise<VoiceOverJobResponse> {
    await this.projects.findOne(userId, projectId);
    const job = await this.prisma.voiceOverJob.findFirst({ where: { id: jobId, projectId } });
    if (!job) throw new NotFoundException("Voice over job not found");
    return this.toResponse(job);
  }

  async cancel(userId: string, projectId: string, jobId: string): Promise<VoiceOverJobResponse> {
    await this.projects.ensureEditable(userId, projectId);
    const job = await this.prisma.voiceOverJob.findFirst({ where: { id: jobId, projectId } });
    if (!job) throw new NotFoundException("Voice over job not found");
    if (!ACTIVE_STATUSES.includes(job.status)) return this.toResponse(job);

    // Cooperative: the processor checks this flag between lines. Killing
    // the worker mid-synthesis would leave a partial file with no way to
    // tell it apart from a complete one.
    const updated = await this.prisma.voiceOverJob.update({ where: { id: job.id }, data: { cancelRequested: true } });
    return this.toResponse(updated);
  }

  private assertUniqueLineIds(lines: VoiceOverLineDto[]): void {
    const seen = new Set<string>();
    for (const line of lines) {
      // Duplicate ids would collide in the per-line timing map, so the
      // UI would attribute one line's measured duration to another.
      if (seen.has(line.id)) throw new BadRequestException(`Duplicate voice over line id "${line.id}"`);
      seen.add(line.id);
    }
  }

  private toResponse(job: VoiceOverJob): VoiceOverJobResponse {
    return {
      ...job,
      lines: job.lines as unknown as VoiceOverLineDto[],
      lineTimings: (job.lineTimings as unknown as LineTiming[] | null) ?? null,
    };
  }
}
