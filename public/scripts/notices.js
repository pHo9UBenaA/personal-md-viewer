import { createButton } from "./dom.js";

export function initializeNotices({ container, region, showNotices, onClose }) {
	let currentStatus = null;
	let copyNoticeDismissed = false;
	function createNotice(id, content, closeLabel, onDismiss) {
		const notice = document.createElement("div");
		notice.id = id;
		notice.className = "notice";
		const message = document.createElement("span");
		message.className = "notice-message";
		message.append(content);
		const close = createButton(
			"×",
			() => {
				notice.remove();
				if (currentStatus === notice) currentStatus = null;
				onDismiss?.();
				onClose();
			},
			"notice-close",
		);
		close.setAttribute("aria-label", closeLabel);
		close.title = closeLabel;
		notice.append(message, close);
		return notice;
	}

	if (showNotices) {
		const content = document.createDocumentFragment();
		const link = document.createElement("a");
		link.href = "/shortcuts";
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		link.textContent = "ショートカットの詳細";
		content.append(
			"一部のショートカットは、ブラウザーの標準操作ではなく Viewer 内の操作に使います。 ",
			link,
		);
		const notice = createNotice(
			"shortcut-notice",
			content,
			"ショートカットの案内を閉じる",
		);
		notice.classList.add("shortcut-notice");
		container.prepend(notice);
	}

	function status(message, error = false, onDismiss) {
		currentStatus?.remove();
		currentStatus = null;
		if (!message) return;
		const notice = createNotice("status", message, "通知を閉じる", onDismiss);
		notice.dataset.error = String(error);
		currentStatus = notice;
		region.append(notice);
	}

	function showCopyNotice() {
		status(
			showNotices && !copyNoticeDismissed
				? "コピーを閲覧中です。マーカーはコピーに保存し、元ファイルは変更しません。"
				: "",
			false,
			() => {
				copyNoticeDismissed = true;
			},
		);
	}

	return { status, showCopyNotice };
}
