/**
 * @file Generates HTML views for the markdown directory listing and individual markdown pages.
 */
import type { UseMarkdownDocuments } from "../hooks/useMarkdownDocuments";
import type { UseMarkdownIndex } from "../hooks/useMarkdownIndex";
import type { MarkdownPathResult } from "../types/markdown";
import { success } from "../types/result";
import { renderLayout } from "./layout";
import { type FileHrefBuilder, renderNavigationTree } from "./navigation";

const DIRECTORY_SEPARATOR = "/" as const;
const INDEX_PAGE_TITLE = "Markdown files" as const;
const BACK_LINK_LABEL = "← Back to list" as const;
const ADD_SOURCE_ACTION = "/sources" as const;
const ADD_SYMLINK_ACTION = "/sources/symlink" as const;
const ADD_SOURCE_METHOD = "post" as const;
const ADD_SOURCE_INPUT_NAME = "directory" as const;
const ADD_FILE_INPUT_NAME = "file" as const;
const TYPE_INPUT_NAME = "type" as const;
const SOURCE_KEY_INPUT_NAME = "sourceKey" as const;
const VIEW_PATH_QUERY = "path" as const;
const buildViewHref: FileHrefBuilder = (file) =>
	`/view?${VIEW_PATH_QUERY}=${encodeURIComponent(file.urlPath)}`;

export type Viewer = {
	readonly buildIndexPage: () => Promise<string>;
	readonly buildMarkdownPage: (
		documentPath: string,
	) => Promise<MarkdownPathResult<string>>;
};

type ViewerDeps = {
	readonly useMarkdownDocuments: UseMarkdownDocuments;
	readonly useMarkdownIndex: UseMarkdownIndex;
};

/**
 * Builds HTML generation helpers for the provided markdown environment.
 */
export const createViewer = ({
	useMarkdownDocuments,
	useMarkdownIndex,
}: ViewerDeps): Viewer => {
	const buildIndexPage = async (): Promise<string> => {
		const { sections } = await useMarkdownIndex();

		const addSourceForm = `
	  <div class="source-forms">
	    <form id="source-form" method="${ADD_SOURCE_METHOD}" action="${ADD_SOURCE_ACTION}" class="add-source-form">
	      <h3>ソースを追加</h3>
	      <div class="form-type-selector">
	        <label>
	          <input type="radio" name="${TYPE_INPUT_NAME}" value="directory" checked />
	          ディレクトリ
	        </label>
	        <label>
	          <input type="radio" name="${TYPE_INPUT_NAME}" value="file" />
	          ファイル
	        </label>
	      </div>
	      <div class="form-row directory-input">
	        <label for="${ADD_SOURCE_INPUT_NAME}">ディレクトリを選択</label>
	        <input type="text" id="${ADD_SOURCE_INPUT_NAME}" name="${ADD_SOURCE_INPUT_NAME}" placeholder="/path/to/docs" />
	        <input type="file" id="directory-picker" webkitdirectory directory multiple style="display: none;" />
	        <button type="button" id="browse-directory" aria-label="Browse for directory">📁</button>
	      </div>
	      <div class="form-row file-input" style="display: none;">
	        <label for="${ADD_FILE_INPUT_NAME}">ファイルを選択</label>
	        <input type="text" id="${ADD_FILE_INPUT_NAME}" name="${ADD_FILE_INPUT_NAME}" placeholder="/path/to/file.md" />
	        <input type="file" id="file-picker" accept=".md,.markdown" style="display: none;" />
	        <button type="button" id="browse-file" aria-label="Browse for file">📄</button>
	      </div>
	      <button type="submit" class="submit-button">追加</button>
	    </form>
	  </div>
	`;

		const sectionsMarkup = sections
			.map(({ source, files, tree }) => {
				const symlinkButton =
					source.key !== "docs"
						? `
					<form method="${ADD_SOURCE_METHOD}" action="${ADD_SYMLINK_ACTION}" class="inline-form">
						<input type="hidden" name="${SOURCE_KEY_INPUT_NAME}" value="${source.key}" />
						<button type="submit" class="symlink-button" title="Create symlink in docs">🔗</button>
					</form>
				`
						: "";

				if (!tree || files.length === 0) {
					return `<section class="source">
						<div class="source-header">
							<h2>${source.name}</h2>
							${symlinkButton}
						</div>
						<p>No markdown files found.</p>
					</section>`;
				}

				const treeMarkup = renderNavigationTree(
					tree,
					buildViewHref,
					"file-tree",
				);

				return `<section class="source">
					<div class="source-header">
						<h2>${source.name}</h2>
						${symlinkButton}
					</div>
					${treeMarkup}
				</section>`;
			})
			.join("");

		const scriptContent = `
			<script>
				document.addEventListener('DOMContentLoaded', function() {
					const form = document.getElementById('source-form');
					const typeRadios = document.querySelectorAll('input[name="type"]');
					const directoryInput = document.querySelector('.directory-input');
					const fileInput = document.querySelector('.file-input');
					const directoryText = document.getElementById('directory');
					const fileText = document.getElementById('file');
					const directoryPicker = document.getElementById('directory-picker');
					const filePicker = document.getElementById('file-picker');
					const browseDirectoryBtn = document.getElementById('browse-directory');
					const browseFileBtn = document.getElementById('browse-file');

					typeRadios.forEach(radio => {
						radio.addEventListener('change', function() {
							if (this.value === 'directory') {
								directoryInput.style.display = 'flex';
								fileInput.style.display = 'none';
								directoryText.required = true;
								fileText.required = false;
							} else {
								directoryInput.style.display = 'none';
								fileInput.style.display = 'flex';
								directoryText.required = false;
								fileText.required = true;
							}
						});
					});

					browseDirectoryBtn.addEventListener('click', function() {
						directoryPicker.click();
					});

					browseFileBtn.addEventListener('click', function() {
						filePicker.click();
					});

					directoryPicker.addEventListener('change', function(e) {
						if (e.target.files.length > 0) {
							const path = e.target.files[0].path || e.target.files[0].webkitRelativePath;
							if (path) {
								const parts = path.split('/');
								if (parts.length > 1) {
									directoryText.value = parts.slice(0, -1).join('/');
								}
							}
						}
					});

					filePicker.addEventListener('change', function(e) {
						if (e.target.files.length > 0) {
							fileText.value = e.target.files[0].name;
						}
					});

					form.addEventListener('submit', function(e) {
						const selectedType = document.querySelector('input[name="type"]:checked').value;
						if (selectedType === 'directory' && !directoryText.value) {
							e.preventDefault();
							alert('ディレクトリを入力してください');
						} else if (selectedType === 'file' && !fileText.value) {
							e.preventDefault();
							alert('ファイルを入力してください');
						}
					});
				});
			</script>
		`;

		return await renderLayout(
			INDEX_PAGE_TITLE,
			`<h1>${INDEX_PAGE_TITLE}</h1>${addSourceForm}${sectionsMarkup}${scriptContent}`,
		);
	};

	const buildMarkdownPage = async (
		documentPath: string,
	): Promise<MarkdownPathResult<string>> => {
		const { renderDocument } = useMarkdownDocuments();
		const markdownResult = await renderDocument(documentPath);

		if (!markdownResult.ok) {
			return markdownResult;
		}

		const directory = documentPath.includes(DIRECTORY_SEPARATOR)
			? `${documentPath.slice(0, documentPath.lastIndexOf(DIRECTORY_SEPARATOR) + 1)}`
			: "";

		const content = `
    <nav><a href="/">${BACK_LINK_LABEL}</a></nav>
    <article>${markdownResult.value}</article>
  `;

		const page = await renderLayout(documentPath, content, {
			baseHref: directory ? `/files/${directory}` : undefined,
		});

		return success(page);
	};

	return {
		buildIndexPage,
		buildMarkdownPage,
	};
};
