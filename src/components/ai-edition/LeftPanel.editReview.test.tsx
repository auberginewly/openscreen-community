// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import {
	DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
	useProjectStore,
} from "@/lib/ai-edition/store/projectStore";
import { clearHistory, undo } from "@/lib/ai-edition/store/undo";
import { past } from "@/lib/ai-edition/store/undoStack";
import { ChatStripPanel } from "./LeftPanel";

const {
	chatRun,
	chatListSessions,
	chatSelectSession,
	chatSetEditStatus,
	save,
	info,
	warning,
	error,
} = vi.hoisted(() => ({
	chatRun: vi.fn(),
	chatListSessions: vi.fn(),
	chatSelectSession: vi.fn(),
	chatSetEditStatus: vi.fn(),
	save: vi.fn(),
	info: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: {
			llmGetSnapshot: async () => ({
				config: { provider: "openai", model: "gpt-4o" },
				connectedProviders: ["openai"],
			}),
			chatListSessions: (...args: unknown[]) => chatListSessions(...args),
			chatSelectSession: (...args: unknown[]) => chatSelectSession(...args),
			chatBudget: async () => null,
			chatRun: (...args: unknown[]) => chatRun(...args),
			chatSetEditStatus: (...args: unknown[]) => chatSetEditStatus(...args),
			save: (...args: unknown[]) => save(...args),
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		info: (...args: unknown[]) => info(...args),
		warning: (...args: unknown[]) => warning(...args),
		error: (...args: unknown[]) => error(...args),
	},
}));
vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: () => undefined }),
	useScopedT: () => (key: string) => key,
}));

let sequence = 0;
const before = createEmptyDocument({ projectId: "project-854", title: "Before" });

beforeEach(() => {
	sequence += 1;
	useProjectStore.getState().clear();
	clearHistory();
	useProjectStore.setState({
		projectId: "project-854",
		document: before,
		revision: 4,
		dirty: false,
	});
	chatRun.mockReset();
	chatListSessions
		.mockReset()
		.mockResolvedValue([
			{ id: "session-854", title: "Review", messageCount: 0, createdAt: "2026-09-27T00:00:00Z" },
		]);
	chatSelectSession.mockReset().mockResolvedValue({
		id: "session-854",
		projectId: "project-854",
		title: "Review",
		createdAt: "2026-09-27T00:00:00Z",
		messages: [],
	});
	chatSetEditStatus.mockReset().mockResolvedValue(true);
	save.mockReset().mockImplementation(async (document) => ({ success: true, document }));
	info.mockReset();
	warning.mockReset();
	error.mockReset();
	Element.prototype.scrollTo = () => undefined;
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => undefined,
	};
});

afterEach(() => {
	cleanup();
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

async function sendTurn(withEdit = true) {
	const messageId = `agent-854-${sequence}`;
	chatRun.mockResolvedValue({
		success: true,
		assistantMessage: {
			id: messageId,
			role: "assistant",
			content: "Here is the result.",
			createdAt: "2026-09-27T00:01:00Z",
			toolCalls: withEdit
				? [
						{ name: "rename", summary: "renamed project", mutating: true },
						{ name: "update", summary: "updated timestamp", mutating: true },
					]
				: undefined,
		},
		document: withEdit ? { ...before, project: { ...before.project, title: "Agent" } } : undefined,
	});
	const view = render(
		<TooltipProvider>
			<EditorDialogsProvider>
				<ChatStripPanel />
			</EditorDialogsProvider>
		</TooltipProvider>,
	);
	await waitFor(() => expect(view.getByPlaceholderText("chat.composerPlaceholder")).toBeEnabled());
	fireEvent.change(view.getByPlaceholderText("chat.composerPlaceholder"), {
		target: { value: "edit it" },
	});
	fireEvent.click(view.getByRole("button", { name: "chat.send" }));
	await waitFor(() => expect(view.getByText("Here is the result.")).toBeInTheDocument());
	return { view, messageId };
}

describe("chat turn review", () => {
	it("keeps a late proposal in the session that requested it", async () => {
		chatListSessions.mockResolvedValue([
			{ id: "session-854", title: "Review", messageCount: 0, createdAt: "2026-09-27T00:00:00Z" },
			{
				id: "session-other",
				title: "Other chat",
				messageCount: 0,
				createdAt: "2026-09-27T00:00:00Z",
			},
		]);
		const messageId = `late-854-${sequence}`;
		const result = {
			success: true,
			assistantMessage: {
				id: messageId,
				role: "assistant",
				content: "Late proposal",
				createdAt: "2026-09-27T00:01:00Z",
				editStatus: "proposed",
			},
			document: { ...before, project: { ...before.project, title: "Agent" } },
		};
		let resolveTurn: ((value: typeof result) => void) | undefined;
		chatRun.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveTurn = resolve;
				}),
		);
		const view = render(
			<TooltipProvider>
				<EditorDialogsProvider>
					<ChatStripPanel />
				</EditorDialogsProvider>
			</TooltipProvider>,
		);
		await waitFor(() =>
			expect(view.getByPlaceholderText("chat.composerPlaceholder")).toBeEnabled(),
		);
		fireEvent.change(view.getByPlaceholderText("chat.composerPlaceholder"), {
			target: { value: "edit" },
		});
		fireEvent.click(view.getByRole("button", { name: "chat.send" }));
		await waitFor(() => expect(chatRun).toHaveBeenCalledOnce());
		chatSelectSession.mockResolvedValue({
			id: "session-other",
			projectId: "project-854",
			title: "Other chat",
			createdAt: "2026-09-27T00:00:00Z",
			messages: [
				{
					id: "other-message",
					role: "assistant",
					content: "Other conversation",
					createdAt: "2026-09-27T00:00:00Z",
				},
			],
		});
		fireEvent.click(view.getByRole("button", { name: "chat.history" }));
		fireEvent.click(view.getByText("Other chat"));
		await waitFor(() => expect(view.getByText("Other conversation")).toBeInTheDocument());
		await act(async () => {
			resolveTurn?.(result);
		});
		expect(view.queryByText("Late proposal")).toBeNull();
		expect(view.queryByRole("button", { name: "chat.applyProposedEdits" })).toBeNull();
		chatSelectSession.mockResolvedValue({
			id: "session-854",
			projectId: "project-854",
			title: "Review",
			createdAt: "2026-09-27T00:00:00Z",
			messages: [result.assistantMessage],
		});
		fireEvent.click(view.getByRole("button", { name: "chat.history" }));
		fireEvent.click(view.getByRole("button", { name: /Review/ }));
		await waitFor(() => expect(view.getByText("Late proposal")).toBeInTheDocument());
		fireEvent.click(view.getByRole("button", { name: "chat.applyProposedEdits" }));
		await waitFor(() =>
			expect(chatSetEditStatus).toHaveBeenCalledWith(
				"project-854",
				"session-854",
				messageId,
				"applied",
			),
		);
	});
	it("shows both proposed tool edits without saving, then applies one undoable project change", async () => {
		const { view, messageId } = await sendTurn();
		expect(view.getByText("chat.editStatus.proposed")).toBeInTheDocument();
		expect(view.getAllByText(/chat.proposedPrefix/)).toHaveLength(2);
		expect(useProjectStore.getState().document).toBe(before);
		expect(save).not.toHaveBeenCalled();
		fireEvent.click(view.getByRole("button", { name: "chat.applyProposedEdits" }));
		await waitFor(() => expect(view.getByText("chat.editStatus.applied")).toBeInTheDocument());
		expect(chatSetEditStatus).toHaveBeenCalledWith(
			"project-854",
			"session-854",
			messageId,
			"applied",
		);
		expect(save).toHaveBeenCalledOnce();
		expect(past).toHaveLength(1);
		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document?.project.title).toBe("Before");
	});

	it("discards the whole turn without touching the project", async () => {
		const { view, messageId } = await sendTurn();
		fireEvent.click(view.getByRole("button", { name: "chat.discardProposedEdits" }));
		await waitFor(() => expect(view.getByText("chat.editStatus.discarded")).toBeInTheDocument());
		expect(chatSetEditStatus).toHaveBeenCalledWith(
			"project-854",
			"session-854",
			messageId,
			"discarded",
		);
		expect(save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document).toBe(before);
	});

	it("marks a changed revision as conflicted without saving", async () => {
		const { view } = await sendTurn();
		useProjectStore
			.getState()
			.setDocument({ ...before, project: { ...before.project, title: "User" } }, { history: true });
		fireEvent.click(view.getByRole("button", { name: "chat.applyProposedEdits" }));
		await waitFor(() => expect(view.getByText("chat.editStatus.conflict")).toBeInTheDocument());
		expect(save).not.toHaveBeenCalled();
		expect(useProjectStore.getState().document?.project.title).toBe("User");
	});

	it("marks a failed save as failed and leaves project and undo unchanged", async () => {
		const { view } = await sendTurn();
		save.mockResolvedValue({ success: false, error: "EACCES" });
		fireEvent.click(view.getByRole("button", { name: "chat.applyProposedEdits" }));
		await waitFor(() => expect(view.getByText("chat.editStatus.failed")).toBeInTheDocument());
		expect(useProjectStore.getState().document).toBe(before);
		expect(past).toHaveLength(0);
	});

	it("retains the proposal and re-enables Apply after waiting for a save times out", async () => {
		const { view, messageId } = await sendTurn();
		vi.useFakeTimers();
		let release: (() => void) | undefined;
		save.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { success: false, error: "EACCES" };
		});
		const earlier = useProjectStore.getState().saveDocument(before, { history: false });
		try {
			fireEvent.click(view.getByRole("button", { name: "chat.applyProposedEdits" }));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(DOCUMENT_SAVES_WAIT_TIMEOUT_MS);
			});
			expect(view.getByText("chat.editStatus.proposed")).toBeInTheDocument();
			expect(view.getByRole("button", { name: "chat.applyProposedEdits" })).toBeEnabled();
			expect(chatSetEditStatus).not.toHaveBeenCalled();
			expect(info).toHaveBeenCalledWith("chat.waitingForSave");
			release?.();
			await act(async () => {
				await earlier;
			});
			await act(async () => {
				fireEvent.click(view.getByRole("button", { name: "chat.applyProposedEdits" }));
			});
			expect(view.getByText("chat.editStatus.applied")).toBeInTheDocument();
			expect(chatSetEditStatus).toHaveBeenCalledWith(
				"project-854",
				"session-854",
				messageId,
				"applied",
			);
		} finally {
			release?.();
			await earlier;
			vi.useRealTimers();
		}
	});

	it("shows a text-only reply with no approval prompt", async () => {
		const { view } = await sendTurn(false);
		expect(view.queryByRole("button", { name: "chat.applyProposedEdits" })).toBeNull();
		expect(save).not.toHaveBeenCalled();
	});

	it("keeps a proposed turn reviewable after the chat panel remounts", async () => {
		const { view, messageId } = await sendTurn();
		view.unmount();
		chatSelectSession.mockResolvedValue({
			id: "session-854",
			projectId: "project-854",
			title: "Review",
			createdAt: "2026-09-27T00:00:00Z",
			messages: [
				{
					id: messageId,
					role: "assistant",
					content: "Here is the result.",
					createdAt: "2026-09-27T00:01:00Z",
					editStatus: "proposed",
				},
			],
		});
		const reopened = render(
			<TooltipProvider>
				<EditorDialogsProvider>
					<ChatStripPanel />
				</EditorDialogsProvider>
			</TooltipProvider>,
		);
		await waitFor(() =>
			expect(reopened.getByRole("button", { name: "chat.applyProposedEdits" })).toBeEnabled(),
		);
		fireEvent.click(reopened.getByRole("button", { name: "chat.applyProposedEdits" }));
		await waitFor(() => expect(reopened.getByText("chat.editStatus.applied")).toBeInTheDocument());
		expect(save).toHaveBeenCalledOnce();
	});

	it("keeps review controls locked across a panel remount while saving", async () => {
		const { view, messageId } = await sendTurn();
		let release: (() => void) | undefined;
		save.mockImplementationOnce(async (document) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { success: true, document };
		});
		fireEvent.click(view.getByRole("button", { name: "chat.applyProposedEdits" }));
		await waitFor(() => expect(release).toBeTypeOf("function"));
		view.unmount();
		chatSelectSession.mockResolvedValue({
			id: "session-854",
			projectId: "project-854",
			title: "Review",
			createdAt: "2026-09-27T00:00:00Z",
			messages: [
				{
					id: messageId,
					role: "assistant",
					content: "Here is the result.",
					createdAt: "2026-09-27T00:01:00Z",
					editStatus: "proposed",
				},
			],
		});
		const reopened = render(
			<TooltipProvider>
				<EditorDialogsProvider>
					<ChatStripPanel />
				</EditorDialogsProvider>
			</TooltipProvider>,
		);
		await waitFor(() =>
			expect(reopened.getByRole("button", { name: "chat.discardProposedEdits" })).toBeDisabled(),
		);
		release?.();
		await waitFor(() => expect(reopened.getByText("chat.editStatus.applied")).toBeInTheDocument());
		expect(save).toHaveBeenCalledOnce();
	});

	it("lets the user discard an orphaned proposal after a renderer reload", async () => {
		const messageId = `orphan-854-${sequence}`;
		chatSelectSession.mockResolvedValue({
			id: "session-854",
			projectId: "project-854",
			title: "Review",
			createdAt: "2026-09-27T00:00:00Z",
			messages: [
				{
					id: messageId,
					role: "assistant",
					content: "Draft",
					createdAt: "2026-09-27T00:01:00Z",
					editStatus: "proposed",
				},
			],
		});
		const view = render(
			<TooltipProvider>
				<EditorDialogsProvider>
					<ChatStripPanel />
				</EditorDialogsProvider>
			</TooltipProvider>,
		);
		await waitFor(() =>
			expect(view.getByRole("button", { name: "chat.applyProposedEdits" })).toBeDisabled(),
		);
		fireEvent.click(view.getByRole("button", { name: "chat.discardProposedEdits" }));
		await waitFor(() => expect(view.getByText("chat.editStatus.discarded")).toBeInTheDocument());
		expect(save).not.toHaveBeenCalled();
	});
});
