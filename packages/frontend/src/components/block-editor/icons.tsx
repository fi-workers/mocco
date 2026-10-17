import {
  Bold,
  Braces,
  Check,
  ChevronDown,
  Code,
  Copy,
  FileText,
  GripVertical,
  Heading,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Italic,
  Link,
  Link2Off,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Search,
  SquareCode,
  Strikethrough,
  Table,
  TextAlignCenter,
  TextAlignStart,
  TextAlignEnd,
  TextQuote,
  Trash2,
  Type,
  Underline,
} from "lucide-react";
import React from "react";

import type { BlockEditorIcons } from "./icon-types";
import { DEFAULT_LANGUAGE_ICONS } from "./language-icons";

const headingIcons: Record<number, React.ComponentType> = {
  1: Heading1,
  2: Heading2,
  3: Heading3,
};

export const HeadingIcon = ({ level }: { level: number }) => {
  const Icon = headingIcons[level] ?? Heading;
  return <Icon />;
};

export const DEFAULT_ICONS: BlockEditorIcons = {
  alignCenterIcon: <TextAlignCenter />,
  alignLeftIcon: <TextAlignStart />,
  alignRightIcon: <TextAlignEnd />,
  boldIcon: <Bold />,
  checkIcon: <Check />,
  codeBlockLanguageIcon: <Braces />,
  codeIcon: <Code />,
  copyIcon: <Copy />,
  deleteIcon: <Trash2 />,
  dragHandleIcon: <GripVertical className="block-editor-drag-handle-icon" />,
  dropdownArrowIcon: <ChevronDown size={12} />,
  fallbackIcon: <FileText />,
  italicIcon: <Italic />,
  languageIcons: DEFAULT_LANGUAGE_ICONS,
  linkIcon: <Link />,
  searchIcon: <Search size={14} />,
  slashBlockquoteIcon: <TextQuote />,
  slashBulletListIcon: <List />,
  slashCodeBlockIcon: <SquareCode />,
  slashDividerIcon: <Minus />,
  slashHeadingIcon: <Heading />,
  slashImageIcon: <Image />,
  slashOrderedListIcon: <ListOrdered />,
  slashTableIcon: <Table />,
  slashTaskListIcon: <ListTodo />,
  slashTextIcon: <Type />,
  strikethroughIcon: <Strikethrough />,
  underlineIcon: <Underline />,
  unlinkIcon: <Link2Off />,
};
