export type DataEpochResult =
  | { allowed: true; action: "stamped-new" | "stamped-upgrade" | "downgrade-allowed"; epoch: number; stampPath: string }
  | { allowed: false; reason: "corrupt-stamp"; detail: string; stampPath: string }
  | {
      allowed: false;
      reason: "epoch-downgrade-blocked";
      stampEpoch: number;
      ownEpoch: number;
      stampLastVersion: string | null;
      stampPath: string;
    };

export function dataEpochStampPath(homeDir: string): string;

export function assertAndStampDataEpoch(args: {
  homeDir: string;
  ownEpoch: number;
  ownVersion: string;
  allowDowngrade?: boolean;
  log?: { warn: (msg: string) => void };
}): Promise<DataEpochResult>;

export function describeDataEpochBlock(args: {
  stampEpoch: number;
  ownEpoch: number;
  stampLastVersion: string | null;
}): string;
