import { isNative } from './io/native';

/**
 * Pixel Fusion Pro: one purchase, kept, that unlocks Export. Building,
 * saving the one project, the character studio and Play are free.
 *
 * The store is reached through RevenueCat, which handles StoreKit receipts,
 * restores and the offline cache. The web copy has no store and everything
 * is open there.
 */

/** The entitlement in RevenueCat that the $14.99 product grants. */
const ENTITLEMENT = 'pro';
/** The non-consumable in App Store Connect. */
const PRODUCT_ID = 'pixelfusion.pro';
const FALLBACK_PRICE = '$14.99';
/** Remembered so a purchase still counts with no connection. */
const OWNED_KEY = 'pf-pro-owned';

const apiKey = (import.meta.env.VITE_REVENUECAT_IOS_KEY as string | undefined) ?? '';

let ready: Promise<typeof import('@revenuecat/purchases-capacitor').Purchases | null> | null = null;

function store() {
  ready ??= (async () => {
    if (!isNative() || !apiKey) return null;
    try {
      const { Purchases } = await import('@revenuecat/purchases-capacitor');
      await Purchases.configure({ apiKey });
      return Purchases;
    } catch {
      return null;
    }
  })();
  return ready;
}

function remember(owned: boolean): boolean {
  try {
    if (owned) localStorage.setItem(OWNED_KEY, '1');
  } catch {
    /* the store still answers next time */
  }
  return owned;
}

function rememberedOwned(): boolean {
  try {
    return localStorage.getItem(OWNED_KEY) === '1';
  } catch {
    return false;
  }
}

type Entitlements = { entitlements: { active: Record<string, unknown> } };
const owns = (info: Entitlements) => ENTITLEMENT in info.entitlements.active;

/** Whether Export is unlocked. Always true on the web copy. */
export async function isPro(): Promise<boolean> {
  if (!isNative()) return true;
  if (rememberedOwned()) return true;
  const purchases = await store();
  if (!purchases) return false;
  try {
    const { customerInfo } = await purchases.getCustomerInfo();
    return remember(owns(customerInfo));
  } catch {
    return false;
  }
}

async function proPackage() {
  const purchases = await store();
  if (!purchases) return null;
  const offerings = await purchases.getOfferings();
  const packages = offerings.current?.availablePackages ?? [];
  return packages.find((p) => p.product.identifier === PRODUCT_ID) ?? packages[0] ?? null;
}

/** The price as the App Store shows it in the buyer's own currency. */
export async function proPrice(): Promise<string> {
  try {
    return (await proPackage())?.product.priceString ?? FALLBACK_PRICE;
  } catch {
    return FALLBACK_PRICE;
  }
}

export type PurchaseOutcome = 'owned' | 'cancelled' | 'unavailable' | 'failed';

export async function buyPro(): Promise<PurchaseOutcome> {
  const purchases = await store();
  if (!purchases) return 'unavailable';
  try {
    const aPackage = await proPackage();
    if (!aPackage) return 'unavailable';
    const { customerInfo } = await purchases.purchasePackage({ aPackage });
    return remember(owns(customerInfo)) ? 'owned' : 'failed';
  } catch (error) {
    const cancelled = !!error && typeof error === 'object' && 'userCancelled' in error && !!error.userCancelled;
    return cancelled ? 'cancelled' : 'failed';
  }
}

/** Apple requires a way to bring back a purchase on a new device. */
export async function restorePro(): Promise<PurchaseOutcome> {
  const purchases = await store();
  if (!purchases) return 'unavailable';
  try {
    const { customerInfo } = await purchases.restorePurchases();
    return remember(owns(customerInfo)) ? 'owned' : 'failed';
  } catch {
    return 'failed';
  }
}
