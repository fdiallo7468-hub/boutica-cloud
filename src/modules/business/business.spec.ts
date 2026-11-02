import {
  BUSINESS_MODULES,
  BUSINESS_SECTORS,
  getDefaultModulesForSector,
  SECTOR_ACTIVITIES,
  validateActivitiesForSector,
} from "./business-taxonomy";
import { BusinessService } from "./business.service";

describe("Business Taxonomy, Sectors, and Modular Configuration", () => {
  describe("Sector Taxonomy Definitions", () => {
    it("defines the two official sectors: QUINCAILLERIE and ELECTRONIQUE", () => {
      expect(BUSINESS_SECTORS.QUINCAILLERIE).toBe("QUINCAILLERIE");
      expect(BUSINESS_SECTORS.ELECTRONIQUE).toBe("ELECTRONIQUE");
    });

    it("includes exactly 6 official activities for QUINCAILLERIE", () => {
      const quincaillerieActivities = SECTOR_ACTIVITIES.QUINCAILLERIE;
      expect(quincaillerieActivities.length).toBe(6);

      const codes = quincaillerieActivities.map((a) => a.code);
      expect(codes).toContain("CONSTRUCTION_MATERIALS");
      expect(codes).toContain("TOOLS_EQUIPMENT");
      expect(codes).toContain("PLUMBING");
      expect(codes).toContain("ELECTRICITY");
      expect(codes).toContain("PAINT");
      expect(codes).toContain("GENERAL_HARDWARE");
    });

    it("includes exactly 6 official activities for ELECTRONIQUE", () => {
      const electroniqueActivities = SECTOR_ACTIVITIES.ELECTRONIQUE;
      expect(electroniqueActivities.length).toBe(6);

      const codes = electroniqueActivities.map((a) => a.code);
      expect(codes).toContain("PHONES_ACCESSORIES");
      expect(codes).toContain("COMPUTERS_IT");
      expect(codes).toContain("TV_AUDIOVISUAL");
      expect(codes).toContain("HOME_APPLIANCES");
      expect(codes).toContain("ELECTRONIC_EQUIPMENT");
      expect(codes).toContain("ELECTRONIC_COMPONENTS");
    });

    it("validates activity compatibility against sector", () => {
      // Valid Quincaillerie activities
      const validQuincaillerie = validateActivitiesForSector("QUINCAILLERIE", [
        "CONSTRUCTION_MATERIALS",
        "PAINT",
      ]);
      expect(validQuincaillerie.valid).toBe(true);
      expect(validQuincaillerie.invalidCodes).toEqual([]);

      // Incompatible mix: Électronique activity under Quincaillerie
      const invalidQuincaillerie = validateActivitiesForSector("QUINCAILLERIE", [
        "CONSTRUCTION_MATERIALS",
        "PHONES_ACCESSORIES",
      ]);
      expect(invalidQuincaillerie.valid).toBe(false);
      expect(invalidQuincaillerie.invalidCodes).toEqual(["PHONES_ACCESSORIES"]);

      // Valid Électronique activities
      const validElec = validateActivitiesForSector("ELECTRONIQUE", [
        "PHONES_ACCESSORIES",
        "COMPUTERS_IT",
      ]);
      expect(validElec.valid).toBe(true);
      expect(validElec.invalidCodes).toEqual([]);
    });

    it("determines default enabled modules for each sector", () => {
      const quincModules = getDefaultModulesForSector("QUINCAILLERIE");
      expect(quincModules).toContain("UNITS_OF_MEASURE");
      expect(quincModules).toContain("UNIT_CONVERSIONS");
      expect(quincModules).toContain("POS_FAST_CHECKOUT");
      expect(quincModules).not.toContain("IMEI_TRACKING");

      const elecModules = getDefaultModulesForSector("ELECTRONIQUE");
      expect(elecModules).toContain("IMEI_TRACKING");
      expect(elecModules).toContain("SERIAL_NUMBERS");
      expect(elecModules).toContain("WARRANTIES");
      expect(elecModules).not.toContain("UNITS_OF_MEASURE");
    });
  });

  describe("BusinessService Data Retention & Soft Updates", () => {
    let businessService: BusinessService;
    let mockDb: any;

    beforeEach(() => {
      mockDb = {
        db: {
          select: jest.fn(),
          insert: jest.fn(),
          update: jest.fn(),
          transaction: jest.fn(async (cb) => cb(mockDb.db)),
        },
      };
      businessService = new BusinessService(mockDb);
    });

    it("returns complete taxonomy via getTaxonomy", () => {
      const taxonomy = businessService.getTaxonomy();
      expect(taxonomy.sectors).toContain("QUINCAILLERIE");
      expect(taxonomy.sectors).toContain("ELECTRONIQUE");
      expect(taxonomy.activitiesBySector.QUINCAILLERIE.length).toBe(6);
      expect(taxonomy.activitiesBySector.ELECTRONIQUE.length).toBe(6);
      expect(taxonomy.modulesCatalogue.length).toBeGreaterThan(5);
    });

    it("never deletes activity rows when updating activities (soft activation / deactivation)", async () => {
      const businessId = "11111111-1111-1111-1111-111111111111";

      // Mock business lookup
      mockDb.db.select.mockImplementation(() => ({
        from: jest.fn().mockImplementation((table) => ({
          where: jest.fn().mockImplementation(() => {
            // First select: business
            return Promise.resolve([
              {
                id: businessId,
                name: "Quincaillerie Centrale",
                sector: "QUINCAILLERIE",
              },
            ]);
          }),
        })),
      }));

      // Existing activities in database: CONSTRUCTION_MATERIALS (active), PAINT (active)
      const existingRows = [
        { id: "act-1", businessId, activity: "CONSTRUCTION_MATERIALS", isActive: true },
        { id: "act-2", businessId, activity: "PAINT", isActive: true },
      ];

      // Second select: existing activities
      mockDb.db.select
        .mockReturnValueOnce({
          from: () => ({ where: () => Promise.resolve([{ id: businessId, sector: "QUINCAILLERIE" }]) }),
        })
        .mockReturnValueOnce({
          from: () => ({ where: () => Promise.resolve(existingRows) }),
        })
        .mockReturnValueOnce({
          from: () => ({
            where: () =>
              Promise.resolve([
                { id: "act-1", businessId, activity: "CONSTRUCTION_MATERIALS", isActive: true },
                { id: "act-2", businessId, activity: "PAINT", isActive: false },
                { id: "act-3", businessId, activity: "PLUMBING", isActive: true },
              ]),
          }),
        });

      mockDb.db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      });

      mockDb.db.insert.mockReturnValue({
        values: jest.fn().mockResolvedValue([]),
      });

      // Update to: keep CONSTRUCTION_MATERIALS, deactivate PAINT, add PLUMBING
      const result = await businessService.updateBusinessActivities(businessId, [
        "CONSTRUCTION_MATERIALS",
        "PLUMBING",
      ]);

      expect(result.success).toBe(true);
      // Soft update occurred (update called to deactivate PAINT without deleting)
      expect(mockDb.db.update).toHaveBeenCalled();
      // Insert called for new activity PLUMBING
      expect(mockDb.db.insert).toHaveBeenCalled();
    });
  });
});
