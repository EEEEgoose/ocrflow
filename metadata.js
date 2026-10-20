// Bibliographic extraction adapted from Auto parent item 0.8.5.
Object.assign(DocFlow, {
  metadataFields: OCRFlowPrompts.metadataFields,

  parseMetadataJSON(content) {
    let text = content.trim();
    let fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    if (text.startsWith("[")) throw new Error("AI 返回了数组，需要 JSON 对象");
    let start = text.indexOf("{");
    let end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("AI 未返回 JSON 对象");
    let data = JSON.parse(text.slice(start, end + 1));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("AI 未返回 JSON 对象");
    return data;
  },

  async identify(markdown, filename, filenameOnly = false, current = {}, settings = this.getLLMSettings(), signal) {
    let system = OCRFlowPrompts.get(filenameOnly ? "parent" : "metadata", settings.workPrompt);
    let content = await this.requestMetadataAI([
        { role: "system", content: system },
        { role: "user", content: `文件名：${filename}\n当前条目：${JSON.stringify(current)}\n\n${filenameOnly ? "仅分析上述文件名。" : `文档文本内容：\n${markdown}`}` },
    ], settings, signal);
    let data;
    try {
      data = this.parseMetadataJSON(content);
    } catch {
      let corrected = await this.requestMetadataAI([
        { role: "system", content: "你是 JSON 格式修复器。只修复以下文本中书目 JSON 对象的语法错误，保留原字段和原值，不推断、不新增书目信息。去掉解释和代码围栏，只输出一个有效 JSON 对象。" },
        { role: "user", content },
      ], settings, signal);
      try {
        data = this.parseMetadataJSON(corrected);
      } catch {
        throw new Error("AI 两次返回的书目 JSON 都无法解析，请重试或检查模型设置。");
      }
    }
    if (typeof data.title !== "string" || !data.title.trim()) {
      if (filenameOnly) data.title = filename.replace(/\.[^.]+$/, "").split(" -- ")[0].trim();
      else if (current.title) data.title = current.title;
      else throw new Error("AI 未识别到标题");
    }
    return data;
  },

  applyMetadata(parent, metadata) {
    let allowed = ["journalArticle", "conferencePaper", "book", "report", "thesis", "document"];
    if (allowed.includes(metadata.itemType)) parent.setType(Zotero.ItemTypes.getID(metadata.itemType));
    for (let field of this.metadataFields) {
      let value = metadata[field];
      if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
        let target = Zotero.ItemFields.isValidForType(field, parent.itemTypeID) ? field :
          ["publisher", "publicationTitle"].includes(field) ?
            Zotero.ItemFields.getFieldIDFromTypeAndBase(parent.itemTypeID, field) : false;
        if (target) parent.setField(target, String(value).trim());
      }
    }
    if (Array.isArray(metadata.creators)) {
      let creators = metadata.creators.filter(creator => creator &&
        typeof creator.lastName === "string" && creator.lastName.trim()).map(creator => {
        let creatorType = creator.creatorType || "author";
        let firstName = typeof creator.firstName === "string" ? creator.firstName.trim() : "";
        let lastName = creator.lastName.trim();
        return { firstName, lastName, creatorType,
          ...(!firstName && /[\u3400-\u9fff]/.test(lastName) ? { fieldMode: 1 } : {}) };
      }).filter(creator => Zotero.CreatorTypes.isValidForItemType(
        Zotero.CreatorTypes.getID(creator.creatorType), parent.itemTypeID));
      if (creators.length) {
        let roles = new Set(creators.map(creator => creator.creatorType));
        let retained = parent.getCreatorsJSON().filter(creator => !roles.has(creator.creatorType));
        parent.setCreators([...creators, ...retained]);
      }
    }
  },

});
