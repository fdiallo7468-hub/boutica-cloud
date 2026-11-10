import { NotFoundException } from "@nestjs/common";
import { BusinessLocationsService } from "./business-locations.service";
import type { DatabaseService } from "../../infrastructure/database/database";

describe("BusinessLocationsService tenant boundaries", () => {
  const businessA = "00000000-0000-4000-8000-000000000001";
  const locationFromBusinessB = "00000000-0000-4000-8000-000000000099";

  it("does not update a location that is not owned by the active business", async () => {
    const query = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const db = {
      select: jest.fn().mockReturnValue(query),
      update: jest.fn(),
    };
    const service = new BusinessLocationsService({ db } as unknown as DatabaseService);

    await expect(service.update(businessA, locationFromBusinessB, {
      name: "Intruder update",
    })).rejects.toBeInstanceOf(NotFoundException);

    expect(db.update).not.toHaveBeenCalled();
    expect(query.where).toHaveBeenCalledTimes(1);
  });

  it("always assigns a newly created location to the tenant supplied by the server", async () => {
    const created = {
      id: "00000000-0000-4000-8000-000000000010",
      businessId: businessA,
      code: "BRANCH-2",
      name: "Agence secondaire",
      isDefault: false,
      isActive: true,
    };
    const insertBuilder = {
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([created]),
    };
    const tx = {
      insert: jest.fn().mockReturnValue(insertBuilder),
    };
    const db = {
      transaction: jest.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    };
    const service = new BusinessLocationsService({ db } as unknown as DatabaseService);

    const result = await service.create(businessA, {
      code: "branch-2",
      name: "Agence secondaire",
    });

    expect(result).toEqual(created);
    expect(insertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      businessId: businessA,
      code: "BRANCH-2",
      isDefault: false,
    }));
  });

  it("does not make a location from another tenant the active default", async () => {
    const query = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    };
    const tx = {
      select: jest.fn().mockReturnValue(query),
      update: jest.fn(),
    };
    const db = {
      transaction: jest.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    };
    const service = new BusinessLocationsService({ db } as unknown as DatabaseService);

    await expect(service.setDefault(businessA, locationFromBusinessB))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(tx.update).not.toHaveBeenCalled();
  });
});
