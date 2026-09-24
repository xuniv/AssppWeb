import { sendDownloadProduct } from "./downloadProduct";
import type { Account, Software } from "../types";

export async function listVersions(
  account: Account,
  app: Software,
): Promise<{ versions: string[]; updatedCookies: typeof account.cookies }> {
  const { dict, updatedCookies } = await sendDownloadProduct(account, app);

  const songList = dict.songList as Record<string, any>[] | undefined;
  if (!songList || songList.length === 0) {
    switch (String(dict.failureType ?? "")) {
      case "2034":
        throw new Error("Password token is expired");
      case "9610":
        throw new Error("License required - purchase the app first");
    }
    const msg = dict.customerMessage as string | undefined;
    throw new Error(msg || "No items in response");
  }

  const item = songList[0];
  const metadata = item.metadata as Record<string, any>;
  if (!metadata) {
    throw new Error("Missing version identifiers");
  }

  const identifiers = metadata.softwareVersionExternalIdentifiers as any[];
  if (!identifiers) {
    throw new Error("Missing version identifiers");
  }

  const versions = identifiers.map((id) => String(id)).reverse();
  if (versions.length === 0) {
    throw new Error("No versions found");
  }

  return { versions, updatedCookies };
}
