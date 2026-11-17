// The control plane's RPC surface (cloud/api ControlPlane entrypoint) as seen by the S3 gateway service binding.

import type { Access } from "./access";

export interface BucketInfo {
    driveId: string;
    alias: string | null;
    displayName: string;
    placement: string | null;
    createdAt: number;
    access: Access;
    writable: boolean;
}
export interface ControlPlane {
    resolveKey(id: string): Promise<{
        accessKeyId: string;
        orgId: string;
        userId: string;
        access: Access;
        drives: string[] | null;
        secretAccessKey: string;
        parent: string | null;
    } | null>;
    recordKeyUse(id: string): Promise<void>;
    listDrives(id: string): Promise<BucketInfo[]>;
    resolveBucket(id: string, bucket: string, want?: "read" | "write"): Promise<BucketInfo>;
    createDrive(id: string, opts: {
        alias: string;
        displayName?: string;
        placement?: string;
    }): Promise<BucketInfo>;
    forkDrive(id: string, opts: {
        source: string;
        alias: string;
    }): Promise<BucketInfo & {
        forkPoint: number;
    }>;
    deleteDrive(id: string, bucket: string, opts: {
        hard: boolean;
    }): Promise<void>;
    describeDrive(id: string, bucket: string): Promise<{
        driveId: string;
        alias: string | null;
        displayName: string;
        createdAt: string;
        forkOf: {
            driveId: string;
            forkPoint: string;
        } | null;
        forks: string[];
        usageBytes: number;
    }>;
    mintChildKey(id: string, opts: {
        drives: string[];
        access?: Access;
        label?: string;
    }): Promise<unknown>;
    mintMountToken(id: string, bucket: string): Promise<unknown>;
}
