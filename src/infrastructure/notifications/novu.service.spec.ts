import { ConfigService } from "@nestjs/config";
import { NovuService } from "./novu.service";
import { QueueService } from "../jobs/queue.service";

describe("NovuService (Notifications)", () => {
  let novuService: NovuService;
  let queueService: QueueService;

  beforeEach(() => {
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    queueService = {
      addJob: jest.fn().mockResolvedValue({ id: "job-123" }),
    } as unknown as QueueService;

    novuService = new NovuService(configService as any, queueService);
  });

  it("devrait fonctionner en mode simulation et ajouter le job à la file de notification", async () => {
    const res = await novuService.triggerStockAlert("b-1", {
      sku: "SKU-TEST",
      productName: "Ciment 50kg",
      currentStock: 2,
      threshold: 5,
    });

    expect(res.success).toBe(true);
    expect(res.async).toBe(true);
    expect(queueService.addJob).toHaveBeenCalled();
  });
});
