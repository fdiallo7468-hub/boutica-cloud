import { ConfigService } from "@nestjs/config";
import { QueueService, QUEUES } from "./queue.service";

describe("QueueService (BullMQ & Redis)", () => {
  let queueService: QueueService;

  beforeEach(async () => {
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    queueService = new QueueService(configService as any);
    await queueService.onModuleInit();
  });

  afterEach(async () => {
    await queueService.onModuleDestroy();
  });

  it("devrait fonctionner en mode fallback immédiat sans crash lorsque Redis est absent", async () => {
    const result = await queueService.addJob(QUEUES.REPORTS, "test-job", { data: 123 });
    expect(result.id).toBeDefined();
    expect(result.id).toContain("direct-");
  });
});
