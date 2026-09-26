import { connect } from "react-redux";
import {
  handleOpenMenu,
  handleMenuMode,
  handleQuoteText,
} from "../../../store/actions";
import { stateType } from "../../../store";
import { withTranslation } from "react-i18next";
import PopupLegal from "./component";

const mapStateToProps = (state: stateType) => {
  return {
    currentBook: state.book.currentBook,
    htmlBook: state.reader.htmlBook,
    quoteText: state.reader.quoteText,
  };
};
const actionCreator = {
  handleOpenMenu,
  handleMenuMode,
  handleQuoteText,
};
export default connect(
  mapStateToProps,
  actionCreator
)(withTranslation()(PopupLegal as any) as any);
