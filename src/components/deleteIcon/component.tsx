import React from "react";
import "./deleteIcon.css";
import { DeleteIconProps, DeleteIconStates } from "./interface";
import DeletePopup from "../dialogs/deletePopup";
import toast from "react-hot-toast";
import DatabaseService from "../../utils/storage/databaseService";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import ConfigUtil from "../../utils/file/configUtil";
import { book } from "../../store/reducers";

class DeleteIcon extends React.Component<DeleteIconProps, DeleteIconStates> {
  constructor(props: DeleteIconProps) {
    super(props);
    this.state = {
      deleteIndex: -1,
      isOpenDelete: false,
    };
  }

  handleDelete = async () => {
    let deleteFunc =
      this.props.mode === "notes"
        ? this.props.handleFetchNotes
        : this.props.handleFetchBookmarks;
    if (this.props.mode === "tags") {
      ConfigService.deleteListConfig(this.props.tagName, "noteTags");
      this.handleDeleteTagFromNote(this.props.tagName);
      return;
    }
    if (this.props.mode === "bookmarks") {
      let bookLocation: {
        text: string;
        count: string;
        chapterTitle: string;
        chapterDocIndex: string;
        chapterHref: string;
        percentage: string;
        cfi: string;
      } = ConfigService.getObjectConfig(
        this.props.currentBook.key,
        "recordLocation",
        {}
      );
      let bookmark = await DatabaseService.getRecord(
        this.props.itemKey,
        "bookmarks"
      );
      if (!bookmark) return;
      if (bookLocation.percentage === bookmark.percentage) {
        this.props.handleShowBookmark(false);
      }
      DatabaseService.deleteRecord(this.props.itemKey, "bookmarks").then(() => {
        deleteFunc();
        toast.success(this.props.t("Deletion successful"));
      });
      return;
    }
    if (this.props.mode === "notes") {
      let note = await DatabaseService.getRecord(this.props.itemKey, "notes");
      if (!note) return;
      if (this.props.htmlBook && this.props.htmlBook.rendition) {
        this.props.htmlBook.rendition.removeOneNote(
          this.props.itemKey,
          note.chapterIndex
        );
      }

      DatabaseService.deleteRecord(this.props.itemKey, "notes").then(() => {
        // 笔记数据已变更，递增全局版本号，使阅读器内的章节缓存失效，
        // 避免后续翻页时将已删除的高亮重新渲染出来
        (window as any).__notesVersion =
          ((window as any).__notesVersion || 0) + 1;
        deleteFunc();
        toast.success(this.props.t("Deletion successful"));
      });

      return;
    }
  };
  handleDeleteTagFromNote = async (tagName: string) => {
    await ConfigUtil.deleteTagFromNotes(tagName);
  };
  handleDeletePopup = (isOpenDelete: boolean) => {
    this.setState({ isOpenDelete });
    if (!isOpenDelete) {
      this.props.handleChangeTag(this.props.index);
    }
  };
  render() {
    const deletePopupProps = {
      name: this.props.tagName,
      title: "Delete this tag",
      description: "This action will clear and remove this tag",
      handleDeletePopup: this.handleDeletePopup,
      handleDeleteOpearion: this.handleDelete,
    };
    return (
      <>
        {this.state.isOpenDelete && (
          <DeletePopup {...(deletePopupProps as any)} />
        )}
        <div
          className="delete-digest-button"
          onClick={() => {
            this.props.mode === "tags"
              ? this.handleDeletePopup(true)
              : this.handleDelete();
          }}
        >
          <span className="icon-close delete-digest-icon"></span>
        </div>
      </>
    );
  }
}

export default DeleteIcon;
