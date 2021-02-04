// Copyright (C) Microsoft Corporation. All rights reserved.

import { expect } from 'chai';
import { DataObject } from '@fluidframework/aqueduct';
import { Container } from '@fluidframework/container-loader';
import { ISerializedHandle } from '@fluidframework/core-interfaces';
import { requestFluidObject } from '@fluidframework/runtime-utils';
import {
	ChannelFactoryRegistry,
	ITestFluidObject,
	LocalTestObjectProvider,
	TestContainerRuntimeFactory,
	TestFluidObjectFactory,
} from '@fluidframework/test-utils';
import { editsPerChunk } from '../EditLog';
import { newEdit, setTrait } from '../EditUtilities';
import { Edit, EditWithoutId } from '../PersistedTypes';
import { SharedTree, SharedTreeEvent } from '../SharedTree';
import { fullHistorySummarizer_0_1_0, SharedTreeSummary } from '../Summary';
import { assertNotUndefined } from '../Common';
import { makeTestNode, testTrait } from './utilities/TestUtilities';

export class TestDataObject extends DataObject {
	public static readonly type = '@fluid-example/test-dataStore';
	public get _root() {
		return this.root;
	}
}

enum DataObjectFactoryType {
	Primed, // default
	Test,
}

interface ITestContainerConfig {
	// TestFluidDataObject instead of PrimedDataStore
	fluidDataObjectType?: DataObjectFactoryType;

	// An array of channel name and DDS factory pairs to create on container creation time
	registry?: ChannelFactoryRegistry;
}

describe('SharedTree history virtualization', () => {
	let localTestObjectProvider: LocalTestObjectProvider<ITestContainerConfig>;

	const treeId = 'test';
	const registry: ChannelFactoryRegistry = [[treeId, SharedTree.getFactory()]];
	const runtimeFactory = (containerOptions?: ITestContainerConfig) =>
		new TestContainerRuntimeFactory(TestDataObject.type, new TestFluidObjectFactory(registry), {
			initialSummarizerDelayMs: 0,
		});

	let sharedTree: SharedTree;

	beforeEach(async () => {
		localTestObjectProvider = new LocalTestObjectProvider(runtimeFactory);

		const container = (await localTestObjectProvider.makeTestContainer()) as Container;
		const dataObject = await requestFluidObject<ITestFluidObject>(container, 'default');
		sharedTree = await dataObject.getSharedObject<SharedTree>(treeId);
		sharedTree.summarizer = fullHistorySummarizer_0_1_0;
	});

	// Adds edits to sharedTree1 to make up the specified number of chunks.
	const processNewEditChunks = async (numberOfChunks = 1) => {
		const expectedEdits: Edit[] = [];

		// Add some edits to create a chunk with.
		while (expectedEdits.length < editsPerChunk * numberOfChunks) {
			const edit = newEdit(setTrait(testTrait, [makeTestNode()]));
			expectedEdits.push(edit);
			sharedTree.processLocalEdit(edit);
		}

		// Wait for the ops to to be submitted and processed across the containers.
		await localTestObjectProvider.opProcessingController.process();

		// Initiate the edit upload
		sharedTree.saveSummary();

		// Wait for each chunk to be uploaded
		await new Promise((resolve) => sharedTree.once(SharedTreeEvent.ChunksUploaded, resolve));

		// Wait for the handle op to be processed.
		await localTestObjectProvider.opProcessingController.process();

		return expectedEdits;
	};

	it('can upload edit chunks and load chunks from handles', async () => {
		const expectedEdits: Edit[] = await processNewEditChunks();

		const summary = sharedTree.saveSummary();

		// Load a second tree using the summary
		const container2 = await localTestObjectProvider.loadTestContainer();
		const dataObject2 = await requestFluidObject<ITestFluidObject>(container2, 'default');
		const sharedTree2 = await dataObject2.getSharedObject<SharedTree>(treeId);

		sharedTree2.loadSummary(summary);

		// Ensure chunked edit can be retrieved
		expect((await sharedTree2.edits.getEditAtIndex(2)).id).to.equal(expectedEdits[2].id);
	});

	it("doesn't upload incomplete chunks", async () => {
		const edit = newEdit(setTrait(testTrait, [makeTestNode()]));
		sharedTree.processLocalEdit(edit);

		// Wait for the op to to be submitted and processed across the containers.
		await localTestObjectProvider.opProcessingController.process();

		// Initiate edit upload
		sharedTree.saveSummary();

		// Wait for each chunk to be uploaded
		await new Promise((resolve) => sharedTree.once(SharedTreeEvent.ChunksUploaded, resolve));

		// Wait for any handle ops to be processed.
		await localTestObjectProvider.opProcessingController.process();

		const { editHistory } = sharedTree.saveSummary() as SharedTreeSummary;
		expect(editHistory).to.not.be.undefined;
		const { editChunks } = assertNotUndefined(editHistory);
		expect(editChunks).to.not.be.undefined;
		expect(editChunks.length).to.equal(1);

		// The chunk given by the summary should be an array of length 1.
		const { chunk } = editChunks[0];
		expect(Array.isArray(chunk)).to.be.true;
		expect((chunk as EditWithoutId[]).length).to.equal(1);
	});

	it('can upload full chunks with incomplete chunks in the edit log', async () => {
		const expectedEdits: Edit[] = [];

		// Add some edits to create a chunk with.
		while (expectedEdits.length < editsPerChunk + 10) {
			const edit = newEdit(setTrait(testTrait, [makeTestNode()]));
			expectedEdits.push(edit);
			sharedTree.processLocalEdit(edit);
		}

		// Wait for the ops to to be submitted and processed across the containers.
		await localTestObjectProvider.opProcessingController.process();

		// Initiate edit upload
		sharedTree.saveSummary();

		// Wait for each chunk to be uploaded
		await new Promise((resolve) => sharedTree.once(SharedTreeEvent.ChunksUploaded, resolve));

		// Wait for the handle op to be processed.
		await localTestObjectProvider.opProcessingController.process();

		const { editHistory } = sharedTree.saveSummary() as SharedTreeSummary;
		expect(editHistory).to.not.be.undefined;
		const { editChunks } = assertNotUndefined(editHistory);
		expect(editChunks).to.not.be.undefined;
		expect(editChunks.length).to.equal(2);
		expect(Array.isArray(editChunks[0].chunk)).to.be.false;
		expect(Array.isArray(editChunks[1].chunk)).to.be.true;
	});

	it('correctly saves handles and their corresponding keys to the summary', async () => {
		await processNewEditChunks(4);

		const { editHistory } = sharedTree.saveSummary() as SharedTreeSummary;
		expect(editHistory).to.not.be.undefined;
		const { editChunks } = assertNotUndefined(editHistory);
		expect(editChunks).to.not.be.undefined;
		expect(editChunks.length).to.equal(4);

		// Make sure each key is correct and each chunk in the summary is a handle
		editChunks.forEach(({ key, chunk }, index) => {
			expect(key).to.equal(index * editsPerChunk);
			expect(Array.isArray(chunk)).to.be.false;
		});
	});

	it('sends handle ops to connected clients when chunks are uploaded', async () => {
		const container2 = await localTestObjectProvider.loadTestContainer();
		const dataObject2 = await requestFluidObject<ITestFluidObject>(container2, 'default');
		const sharedTree2 = await dataObject2.getSharedObject<SharedTree>(treeId);
		sharedTree2.summarizer = fullHistorySummarizer_0_1_0;

		const container3 = await localTestObjectProvider.loadTestContainer();
		const dataObject3 = await requestFluidObject<ITestFluidObject>(container3, 'default');
		const sharedTree3 = await dataObject3.getSharedObject<SharedTree>(treeId);
		sharedTree3.summarizer = fullHistorySummarizer_0_1_0;

		// All shared trees should have no edits or chunks
		expect((sharedTree.saveSummary() as SharedTreeSummary).editHistory?.editChunks.length).to.equal(0);
		expect((sharedTree2.saveSummary() as SharedTreeSummary).editHistory?.editChunks.length).to.equal(0);
		expect((sharedTree3.saveSummary() as SharedTreeSummary).editHistory?.editChunks.length).to.equal(0);

		await processNewEditChunks();

		// All shared trees should have the new handle
		const sharedTreeSummary = sharedTree.saveSummary() as SharedTreeSummary;
		const sharedTree2Summary = sharedTree2.saveSummary() as SharedTreeSummary;
		const sharedTree3Summary = sharedTree3.saveSummary() as SharedTreeSummary;
		const sharedTreeChunk = assertNotUndefined(sharedTreeSummary.editHistory).editChunks[0].chunk;

		// Make sure the chunk is the first shared tree is a serialized handle
		expect((sharedTreeChunk as ISerializedHandle).type === '__fluid_handle__');

		expect(sharedTreeSummary).to.deep.equal(sharedTree2Summary);
		expect(sharedTree2Summary).to.deep.equal(sharedTree3Summary);
	});
});
