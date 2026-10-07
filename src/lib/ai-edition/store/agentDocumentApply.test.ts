// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../schema";
import {
	applyAgentDocumentIfCurrent,
	createAgentEditReview,
	runAgentTurn,
} from "./agentDocumentApply";
import { DOCUMENT_SAVES_WAIT_TIMEOUT_MS, useProjectStore } from "./projectStore";
import { clearHistory, redo, undo } from "./undo";
import { future, past } from "./undoStack";

const saveMock = vi.hoisted(() => vi.fn());

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: { save: saveMock },
	},
}));

describe("applyAgentDocumentIfCurrent", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		saveMock.mockReset();
	});

	it("applies an agent result when the document revision is unchanged", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const agentResult = {
			...before,
			project: { ...before.project, title: "Agent edit" },
		};
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		saveMock.mockImplementation(async (document) => ({ success: true, document }));

		await expect(applyAgentDocumentIfCurrent(agentResult, 4)).resolves.toBe("applied");

		expect(saveMock).toHaveBeenCalledOnce();
		expect(useProjectStore.getState().document?.project.title).toBe("Agent edit");
	});

	it("preserves a manual edit made after the agent snapshot", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const agentResult = {
			...before,
			project: { ...before.project, title: "Agent edit" },
		};
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		useProjectStore.getState().setDocument(
			{
				...before,
				project: { ...before.project, title: "Manual edit" },
			},
			{ history: true },
		);

		await expect(applyAgentDocumentIfCurrent(agentResult, 4)).resolves.toBe("conflict");

		expect(saveMock).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.project.title).toBe("Manual edit");
	});

	it("waits for an earlier manual save before checking the approval revision", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const manual = { ...before, project: { ...before.project, title: "Manual" } };
		const agent = { ...before, project: { ...before.project, title: "Agent" } };
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		let release: (() => void) | undefined;
		saveMock.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { success: true, document: manual };
		});
		const manualSave = useProjectStore.getState().saveDocument(manual, { history: true });
		const applying = applyAgentDocumentIfCurrent(agent, 4);
		expect(saveMock).toHaveBeenCalledOnce();
		release?.();
		await manualSave;
		await expect(applying).resolves.toBe("conflict");
		expect(saveMock).toHaveBeenCalledOnce();
		expect(useProjectStore.getState().document?.project.title).toBe("Manual");
	});

	it("leaves the document unchanged when the save fails, and does not call it applied", async () => {
		// `saveDocument` reports failures by resolving false. The proposal must stay
		// off screen and out of undo history when the disk write is rejected.
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const agentResult = { ...before, project: { ...before.project, title: "Agent edit" } };
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		saveMock.mockResolvedValue({ success: false, error: "EACCES" });

		await expect(applyAgentDocumentIfCurrent(agentResult, 4)).resolves.toBe("save-failed");

		expect(useProjectStore.getState().document?.project.title).toBe("Before");
		expect(useProjectStore.getState().dirty).toBe(false);
	});

	it("keeps a timed-out approval retryable after the earlier save settles", async () => {
		vi.useFakeTimers();
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const proposal = { ...before, project: { ...before.project, title: "Agent" } };
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		let release: (() => void) | undefined;
		saveMock.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { success: false, error: "EACCES" };
		});
		const earlier = useProjectStore.getState().saveDocument(before, { history: false });
		const review = createAgentEditReview(() => applyAgentDocumentIfCurrent(proposal, 4));
		try {
			const applying = review.apply();
			await vi.advanceTimersByTimeAsync(DOCUMENT_SAVES_WAIT_TIMEOUT_MS);
			await expect(applying).resolves.toBe("proposed");
			expect(review.applying).toBe(false);
			expect(useProjectStore.getState().document).toBe(before);
			release?.();
			await earlier;
			saveMock.mockImplementation(async (document) => ({ success: true, document }));
			await expect(review.apply()).resolves.toBe("applied");
			expect(saveMock).toHaveBeenCalledTimes(2);
		} finally {
			release?.();
			await earlier;
			vi.useRealTimers();
		}
	});

	it("does not install an approved save over a newer live edit", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const proposal = { ...before, project: { ...before.project, title: "Agent" } };
		const manual = { ...before, project: { ...before.project, title: "Manual" } };
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		let release: (() => void) | undefined;
		saveMock.mockImplementationOnce(async (document) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { success: true, document };
		});
		const applying = applyAgentDocumentIfCurrent(proposal, 4);
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		useProjectStore.getState().setDocument(manual, { history: true });
		release?.();
		await expect(applying).resolves.toBe("save-failed");
		expect(useProjectStore.getState().document).toBe(manual);
		expect(past).toHaveLength(1);
	});

	it.each([
		"approval-first",
		"manual-first",
	])("refuses an approval overtaken by a direct editor save (%s)", async (order) => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const proposal = { ...before, project: { ...before.project, title: "Agent" } };
		const manual = { ...before, project: { ...before.project, title: "Manual" } };
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		const releases: Array<() => void> = [];
		saveMock.mockImplementation(async (document) => {
			await new Promise<void>((resolve) => releases.push(resolve));
			return { success: true, document };
		});
		const review = createAgentEditReview(() => applyAgentDocumentIfCurrent(proposal, 4));
		const applying = review.apply();
		await vi.waitFor(() => expect(releases).toHaveLength(1));
		// Timeline and inspector actions save directly, without setDocument first.
		const manualSave = useProjectStore.getState().saveDocument(manual, { history: true });
		try {
			if (order === "approval-first") {
				releases[0]();
				expect(useProjectStore.getState().document).toBe(before);
				expect(past).toHaveLength(0);
				releases[1]();
				await manualSave;
				await expect(applying).resolves.toBe("failed");
			} else {
				releases[1]();
				await manualSave;
				releases[0]();
				await expect(applying).resolves.toBe("failed");
			}
			expect(review.status).toBe("failed");
			expect(useProjectStore.getState().document?.project.title).toBe("Manual");
			expect(past).toHaveLength(1);
			expect(undo()).toBe(true);
			expect(useProjectStore.getState().document?.project.title).toBe("Before");
		} finally {
			for (const release of releases) release();
			await Promise.all([applying, manualSave]);
		}
	});

	it("keeps a confirmed approval when the overlapping manual save fails", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const proposal = { ...before, project: { ...before.project, title: "Agent" } };
		const manual = { ...before, project: { ...before.project, title: "Manual" } };
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		let releaseApproval: (() => void) | undefined;
		let releaseManual: (() => void) | undefined;
		saveMock
			.mockImplementationOnce(async (document) => {
				await new Promise<void>((resolve) => {
					releaseApproval = resolve;
				});
				return { success: true, document };
			})
			.mockImplementationOnce(async () => {
				await new Promise<void>((resolve) => {
					releaseManual = resolve;
				});
				return { success: false, error: "ENOSPC" };
			});
		const review = createAgentEditReview(() => applyAgentDocumentIfCurrent(proposal, 4));
		const applying = review.apply();
		await vi.waitFor(() => expect(releaseApproval).toBeTypeOf("function"));
		const manualSave = useProjectStore.getState().saveDocument(manual, { history: true });
		releaseApproval?.();
		releaseManual?.();
		await expect(manualSave).resolves.toBe(false);
		await expect(applying).resolves.toBe("applied");
		expect(useProjectStore.getState().document?.project.title).toBe("Agent");
		expect(past).toHaveLength(1);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
	});

	it("leaves no undo step behind a rejected agent edit", async () => {
		// The rollback is a `setState` by design, so it cannot pop an entry the apply
		// already pushed. Recording on the optimistic `setDocument` therefore left a
		// phantom Ctrl+Z step for an edit that never reached disk -- and `pushHistory`
		// had cleared `future` on the way in, so the user's redo went with it.
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });

		// A real edit and an undo first, so there is a redo entry to lose.
		saveMock.mockResolvedValueOnce({
			success: true,
			document: { ...before, project: { ...before.project, title: "User edit" } },
		});
		await useProjectStore
			.getState()
			.saveDocument(
				{ ...before, project: { ...before.project, title: "User edit" } },
				{ history: true },
			);
		expect(undo()).toBe(true);
		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);

		saveMock.mockResolvedValue({ success: false, error: "EACCES" });
		const agentResult = { ...before, project: { ...before.project, title: "Agent edit" } };
		await expect(applyAgentDocumentIfCurrent(agentResult)).resolves.toBe("save-failed");

		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);
		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("User edit");
	});

	it("does not roll back over an undo that overtook its save", async () => {
		// `saveDocument` resolves false for two different things now: the write failed,
		// and the write was superseded by an undo while it was in flight. The rollback
		// above is right for the first and catastrophic for the second -- it would put
		// the agent's pre-edit document over the one the user just asked to return to,
		// on the agent's behalf, seconds after they pressed Ctrl+Z.
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });

		// A user edit to have something to undo TO, then hold the agent's save open.
		saveMock.mockImplementation(async (document: unknown) => ({ success: true, document }));
		await useProjectStore
			.getState()
			.saveDocument(
				{ ...before, project: { ...before.project, title: "User edit" } },
				{ history: true },
			);

		let release: (() => void) | undefined;
		saveMock.mockImplementationOnce(async (document: unknown) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { success: true, document };
		});
		const agentResult = { ...before, project: { ...before.project, title: "Agent edit" } };
		const applying = applyAgentDocumentIfCurrent(agentResult);
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));

		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Before");

		release?.();
		await expect(applying).resolves.toBe("save-failed");

		expect(useProjectStore.getState().document?.project.title).toBe("Before");
	});

	it("records exactly one undo step for an agent edit that lands", async () => {
		// One successful save records the pre-agent document as its undo base.
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const agentResult = { ...before, project: { ...before.project, title: "Agent edit" } };
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		saveMock.mockImplementation(async (document) => ({ success: true, document }));

		await expect(applyAgentDocumentIfCurrent(agentResult, 4)).resolves.toBe("applied");

		expect(past).toHaveLength(1);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
	});

	it("keeps the live document unchanged until the approved save succeeds", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		const agentResult = { ...before, project: { ...before.project, title: "Agent edit" } };
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		let release: (() => void) | undefined;
		saveMock.mockImplementationOnce(async (document: unknown) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { success: true, document };
		});
		const applying = applyAgentDocumentIfCurrent(agentResult, 4);
		expect(useProjectStore.getState().document).toBe(before);
		expect(useProjectStore.getState().revision).toBe(4);
		expect(past).toHaveLength(0);
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		release?.();
		await expect(applying).resolves.toBe("applied");
		expect(useProjectStore.getState().document?.project.title).toBe("Agent edit");
	});

	it("still rejects when the agent hands back something that is not a document", async () => {
		// The one throw left on this path, and the reason the caller keeps a try/catch.
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });

		await expect(applyAgentDocumentIfCurrent({ not: "a document" }, 4)).rejects.toThrow();

		expect(useProjectStore.getState().document?.project.title).toBe("Before");
		expect(saveMock).not.toHaveBeenCalled();
	});

	it("allows an explicit rewind to replace the current revision", async () => {
		const current = createEmptyDocument({ projectId: "project_1", title: "Current" });
		const checkpoint = {
			...current,
			project: { ...current.project, title: "Checkpoint" },
		};
		useProjectStore.setState({ projectId: "project_1", document: current, revision: 9 });
		saveMock.mockImplementation(async (document) => ({ success: true, document }));

		await expect(applyAgentDocumentIfCurrent(checkpoint)).resolves.toBe("applied");

		expect(useProjectStore.getState().document?.project.title).toBe("Checkpoint");
	});
});

describe("runAgentTurn", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		saveMock.mockReset();
	});

	it("refuses to apply when the document moved WHILE the turn was running", async () => {
		// The assertion the guard actually needs. Reading `revision` after the await --
		// the one-line mistake that restores the bug in full -- leaves every other test in
		// this file green, because they all move the store before the turn starts.
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		saveMock.mockImplementation(async (document) => ({ success: true, document }));

		const { result, applyDocument } = await runAgentTurn(async (documentSnapshot) => {
			// A background transcription landing mid-turn, which is the common case.
			useProjectStore.getState().setDocument(
				{
					...before,
					project: { ...before.project, title: "Manual edit" },
				},
				{ history: true },
			);
			return {
				document: { ...documentSnapshot, project: { ...before.project, title: "Agent edit" } },
			};
		});

		expect(result.document).toBeTruthy();
		await expect(applyDocument()).resolves.toBe("conflict");
		expect(saveMock).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.project.title).toBe("Manual edit");
	});

	it("cannot apply a stale turn on a second approval attempt", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		saveMock.mockImplementation(async (document) => ({ success: true, document }));

		const { applyDocument } = await runAgentTurn(async () => {
			useProjectStore.getState().setDocument(
				{
					...before,
					project: { ...before.project, title: "Manual edit" },
				},
				{ history: true },
			);
			return { document: { ...before, project: { ...before.project, title: "Agent edit" } } };
		});

		await expect(applyDocument()).resolves.toBe("conflict");
		await expect(applyDocument()).resolves.toBe("conflict");
		expect(saveMock).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.project.title).toBe("Manual edit");
	});

	it("never writes a text-only turn over a real project", async () => {
		// With no document open the agent runs against an empty stand-in that still
		// carries the real project id, so a matching revision must not be enough.
		useProjectStore.setState({ projectId: "project_1", document: null, revision: 0 });
		saveMock.mockImplementation(async (document) => ({ success: true, document }));

		const { applyDocument } = await runAgentTurn(async (documentSnapshot) => {
			expect(documentSnapshot).toBeUndefined();
			return { document: createEmptyDocument({ projectId: "project_1", title: "Empty" }) };
		});

		await expect(applyDocument()).resolves.toBe("no-live-document");
		expect(saveMock).not.toHaveBeenCalled();
	});
});

describe("turn-level edit review", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		saveMock.mockReset();
	});

	it("stages a multi-tool result without writing, then applies both edits as one undo step", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		const secondTimestamp = "2026-09-27T10:00:00.000Z";
		const { result, applyDocument } = await runAgentTurn(async (snapshot) => ({
			document: {
				...snapshot,
				project: { ...before.project, title: "New title", updatedAt: secondTimestamp },
			},
			toolCalls: [
				{ name: "rename", summary: "renamed project" },
				{ name: "update", summary: "updated project time" },
			],
		}));
		const review = createAgentEditReview(applyDocument);
		expect(result.toolCalls).toHaveLength(2);
		expect(review.status).toBe("proposed");
		expect(useProjectStore.getState().document).toBe(before);
		expect(saveMock).not.toHaveBeenCalled();
		expect(past).toHaveLength(0);

		saveMock.mockImplementation(async (document) => ({ success: true, document }));
		await expect(review.apply()).resolves.toBe("applied");
		expect(useProjectStore.getState().document?.project.title).toBe("New title");
		expect(useProjectStore.getState().document?.project.updatedAt).toBe(secondTimestamp);
		expect(saveMock).toHaveBeenCalledOnce();
		expect(past).toHaveLength(1);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
	});

	it("keeps the live project isolated even if a tool mutates its input in place", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		const { result } = await runAgentTurn(async (snapshot) => {
			if (!snapshot) throw new Error("missing snapshot");
			snapshot.project.title = "Agent";
			return { document: snapshot };
		});
		expect(result.document.project.title).toBe("Agent");
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
		expect(useProjectStore.getState().revision).toBe(4);
		expect(saveMock).not.toHaveBeenCalled();
	});

	it("discards without a document write or undo entry", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		const { applyDocument } = await runAgentTurn(async () => ({
			document: { ...before, project: { ...before.project, title: "Agent" } },
		}));
		const review = createAgentEditReview(applyDocument);
		expect(review.discard()).toBe("discarded");
		await expect(review.apply()).resolves.toBe("discarded");
		expect(useProjectStore.getState().document).toBe(before);
		expect(saveMock).not.toHaveBeenCalled();
		expect(past).toHaveLength(0);
	});

	it("rejects a revision that changed while awaiting approval", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		const { applyDocument } = await runAgentTurn(async () => ({
			document: { ...before, project: { ...before.project, title: "Agent" } },
		}));
		const review = createAgentEditReview(applyDocument);
		useProjectStore
			.getState()
			.setDocument({ ...before, project: { ...before.project, title: "User" } }, { history: true });
		await expect(review.apply()).resolves.toBe("conflict");
		expect(useProjectStore.getState().document?.project.title).toBe("User");
		expect(saveMock).not.toHaveBeenCalled();
	});

	it("reports a failed save without leaving the proposal on screen or in undo", async () => {
		const before = createEmptyDocument({ projectId: "project_1", title: "Before" });
		useProjectStore.setState({ projectId: "project_1", document: before, revision: 4 });
		const { applyDocument } = await runAgentTurn(async () => ({
			document: { ...before, project: { ...before.project, title: "Agent" } },
		}));
		const review = createAgentEditReview(applyDocument);
		saveMock.mockResolvedValue({ success: false, error: "EACCES" });
		await expect(review.apply()).resolves.toBe("failed");
		expect(useProjectStore.getState().document).toBe(before);
		expect(useProjectStore.getState().dirty).toBe(false);
		expect(past).toHaveLength(0);
	});
});
