import { IObjectStorageService } from "./document";
import { IDocumentStorageService, ISnapshotTree } from "./storage";

export class ObjectStorageService implements IObjectStorageService {
    private static flattenTree(base: string, tree: ISnapshotTree, results: { [path: string]: string }) {
        // tslint:disable-next-line:forin
        for (const path in tree.trees) {
            ObjectStorageService.flattenTree(`${base}/${path}`, tree.trees[path], results);
        }

        // tslint:disable-next-line:forin
        for (const blob in tree.blobs) {
            results[`${base}${blob}`] = tree.blobs[blob];
        }
    }

    private flattenedTree: { [path: string]: string } = {};

    constructor(tree: ISnapshotTree, private storage: IDocumentStorageService) {
        // Create a map from paths to blobs
        if (tree) {
            ObjectStorageService.flattenTree("", tree, this.flattenedTree);
        }
    }

    public read(path: string): Promise<string> {
        const sha = this.getShaForPath(path);
        return this.storage.read(sha);
    }

    private getShaForPath(path: string): string {
        return this.flattenedTree[path];
    }
}
