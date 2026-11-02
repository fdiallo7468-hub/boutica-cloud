/**
 * Boutica Cloud — Taxonomie Commerciale Officielle
 *
 * Définit les secteurs d'activité, les activités commerciales rattachées
 * et les modules fonctionnels applicables (Quincaillerie & Électronique).
 */

export const BUSINESS_SECTORS = {
  QUINCAILLERIE: 'QUINCAILLERIE',
  ELECTRONIQUE: 'ELECTRONIQUE',
} as const;

export type BusinessSectorType = (typeof BUSINESS_SECTORS)[keyof typeof BUSINESS_SECTORS];

export interface ActivityDefinition {
  code: string;
  label: string;
  description: string;
  sector: BusinessSectorType;
}

export interface ModuleDefinition {
  code: string;
  name: string;
  description: string;
  sectorCompatibility: BusinessSectorType[] | 'ALL';
  defaultEnabled: boolean;
}

/**
 * Activités commerciales officielles par secteur.
 * Structure extensible conçue pour accueillir de futurs métiers sans casser l'existant.
 */
export const SECTOR_ACTIVITIES: Record<BusinessSectorType, ActivityDefinition[]> = {
  QUINCAILLERIE: [
    {
      code: 'CONSTRUCTION_MATERIALS',
      label: 'Matériaux de construction',
      description: 'Ciment, fer à béton, agrégats, briques, parpaings et gros œuvre',
      sector: 'QUINCAILLERIE',
    },
    {
      code: 'TOOLS_EQUIPMENT',
      label: 'Outillage et équipements',
      description: 'Outillage à main, électroportatif, matériel de chantier et protection',
      sector: 'QUINCAILLERIE',
    },
    {
      code: 'PLUMBING',
      label: 'Plomberie',
      description: 'Tuyauterie PVC, cuivre, raccords, robinetterie et sanitaires',
      sector: 'QUINCAILLERIE',
    },
    {
      code: 'ELECTRICITY',
      label: 'Électricité',
      description: 'Câbles, gaines, appareillage, disjoncteurs et éclairage',
      sector: 'QUINCAILLERIE',
    },
    {
      code: 'PAINT',
      label: 'Peinture',
      description: 'Peintures bâtiment, vernis, solvants, rouleaux et pinceaux',
      sector: 'QUINCAILLERIE',
    },
    {
      code: 'GENERAL_HARDWARE',
      label: 'Quincaillerie générale',
      description: 'Visserie, boulonnerie, serrures, cadenas, tôles et fixations',
      sector: 'QUINCAILLERIE',
    },
  ],
  ELECTRONIQUE: [
    {
      code: 'PHONES_ACCESSORIES',
      label: 'Téléphones et accessoires',
      description: 'Smartphones, téléphones basiques, chargeurs, câbles et protections d’écran',
      sector: 'ELECTRONIQUE',
    },
    {
      code: 'COMPUTERS_IT',
      label: 'Informatique et ordinateurs',
      description: 'PC portables, unités centrales, moniteurs, claviers et stockage SSD/HDD',
      sector: 'ELECTRONIQUE',
    },
    {
      code: 'TV_AUDIOVISUAL',
      label: 'Téléviseurs et audiovisuel',
      description: 'Écrans TV, barres de son, récepteurs, haut-parleurs et câblage vidéo',
      sector: 'ELECTRONIQUE',
    },
    {
      code: 'HOME_APPLIANCES',
      label: 'Électroménager',
      description: 'Réfrigérateurs, climatiseurs, ventilateurs, micro-ondes et cuisinières',
      sector: 'ELECTRONIQUE',
    },
    {
      code: 'ELECTRONIC_EQUIPMENT',
      label: 'Équipements électroniques',
      description: 'Stabilisateurs de tension, onduleurs UPS, panneaux solaires et batteries',
      sector: 'ELECTRONIQUE',
    },
    {
      code: 'ELECTRONIC_COMPONENTS',
      label: 'Accessoires et composants électroniques',
      description: 'Cartes mémoires, clés USB, adaptateurs, puces, nappes et composants',
      sector: 'ELECTRONIQUE',
    },
  ],
};

/**
 * Catalogue des modules fonctionnels de Boutica Cloud.
 */
export const BUSINESS_MODULES: ModuleDefinition[] = [
  // Modules spécialisés Électronique
  {
    code: 'IMEI_TRACKING',
    name: 'Traçabilité IMEI',
    description: 'Enregistrement et contrôle des numéros IMEI à la vente et au service après-vente',
    sectorCompatibility: ['ELECTRONIQUE'],
    defaultEnabled: true,
  },
  {
    code: 'SERIAL_NUMBERS',
    name: 'Numéros de Série',
    description: 'Gestion unitaire des numéros de série par machine, écran ou équipement',
    sectorCompatibility: ['ELECTRONIQUE'],
    defaultEnabled: true,
  },
  {
    code: 'WARRANTIES',
    name: 'Gestion des Garanties',
    description: 'Suivi des durées de garantie constructeur et édition des attestations de garantie',
    sectorCompatibility: ['ELECTRONIQUE'],
    defaultEnabled: true,
  },
  {
    code: 'DEVICE_MANAGEMENT',
    name: 'Fiches Appareils',
    description: 'Gestion des spécifications techniques (RAM, ROM, Processeur, Couleur)',
    sectorCompatibility: ['ELECTRONIQUE'],
    defaultEnabled: true,
  },
  {
    code: 'REPAIRS_AFTERSALES',
    name: 'Service Après-Vente & Réparations',
    description: 'Ordres de réparation, diagnostics pannes et suivi des réparations atelier',
    sectorCompatibility: ['ELECTRONIQUE'],
    defaultEnabled: false,
  },

  // Modules spécialisés Quincaillerie
  {
    code: 'UNITS_OF_MEASURE',
    name: 'Unités de mesure',
    description: 'Prise en charge des sacs, mètres, tonnes, barres, rouleaux, litres, cartons',
    sectorCompatibility: ['QUINCAILLERIE'],
    defaultEnabled: true,
  },
  {
    code: 'UNIT_CONVERSIONS',
    name: 'Conversions d’unités',
    description: 'Conversions automatiques (ex: 1 tonne = 20 sacs de 50 kg, 1 rouleau = 50 mètres)',
    sectorCompatibility: ['QUINCAILLERIE'],
    defaultEnabled: true,
  },
  {
    code: 'PRODUCT_VARIANTS',
    name: 'Variantes et calibres',
    description: 'Déclinaisons de diamètres (Fer 6, 8, 10, 12) et de nuances',
    sectorCompatibility: ['QUINCAILLERIE', 'ELECTRONIQUE'],
    defaultEnabled: true,
  },
  {
    code: 'PACKAGING_MANAGEMENT',
    name: 'Conditionnements & Palettes',
    description: 'Gestion des palettes consignées et emballages de transport',
    sectorCompatibility: ['QUINCAILLERIE'],
    defaultEnabled: false,
  },
  {
    code: 'MULTI_UNIT_SALES',
    name: 'Vente multi-unités',
    description: 'Vente au détail ou au gros avec tarification dynamique selon l’unité choisie',
    sectorCompatibility: ['QUINCAILLERIE'],
    defaultEnabled: true,
  },

  // Modules Communs / Universels
  {
    code: 'POS_FAST_CHECKOUT',
    name: 'Caisse Rapide Comptoir',
    description: 'Saisie ultra-rapide des tickets de caisse et raccourcis clavier F2',
    sectorCompatibility: 'ALL',
    defaultEnabled: true,
  },
  {
    code: 'DISCOUNT_MANAGEMENT',
    name: 'Remises Commerciales',
    description: 'Gestion des remises au comptoir déduites du sous-total',
    sectorCompatibility: 'ALL',
    defaultEnabled: true,
  },
  {
    code: 'THERMAL_RECEIPTS',
    name: 'Reçus Thermiques 80mm & Factures',
    description: 'Édition de tickets conformes aux standards fiscaux et commerciaux',
    sectorCompatibility: 'ALL',
    defaultEnabled: true,
  },
  {
    code: 'STOCK_AUDIT',
    name: 'Régularisations & Audit de Stock',
    description: 'Historisation détaillée de tous les mouvements et constats d’avaries',
    sectorCompatibility: 'ALL',
    defaultEnabled: true,
  },
];

/**
 * Valide si une liste d'activités est valide et compatible avec un secteur donné.
 */
export function validateActivitiesForSector(
  sector: BusinessSectorType,
  activities: string[],
): { valid: boolean; invalidCodes: string[] } {
  const allowedCodes = new Set(SECTOR_ACTIVITIES[sector]?.map((a) => a.code) || []);
  const invalidCodes = activities.filter((code) => !allowedCodes.has(code));
  return {
    valid: invalidCodes.length === 0,
    invalidCodes,
  };
}

/**
 * Retourne les modules activés par défaut pour un secteur.
 */
export function getDefaultModulesForSector(sector: BusinessSectorType): string[] {
  return BUSINESS_MODULES.filter(
    (m) =>
      m.defaultEnabled &&
      (m.sectorCompatibility === 'ALL' || m.sectorCompatibility.includes(sector)),
  ).map((m) => m.code);
}
