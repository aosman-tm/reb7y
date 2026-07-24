import prisma from "../db.server";

export type ShopSettings = {
  id: string;
  shop: string;
  currency: string;
  paymentFeePercent: number;
  paymentFeeFlat: number;
  codFeePercent: number;
  codRoundTripDefault: boolean;
  returnDeliveryMode: string;
  returnDeliveryPercent: number;
  returnDeliveryFixed: number;
};

/** Get the shop's settings row, creating a default one on first use. */
export async function getSettings(shop: string): Promise<ShopSettings> {
  const existing = await prisma.settings.findUnique({ where: { shop } });
  if (existing) return existing;
  return prisma.settings.create({ data: { shop } });
}
