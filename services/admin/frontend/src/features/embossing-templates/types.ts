export interface EmbossingTemplateRow {
  id: string;
  name: string;
  description: string | null;
  supportsVisa: boolean;
  supportsMastercard: boolean;
  supportsAmex: boolean;
  formatType: string;
  recordLength: number | null;
  fieldCount: number | null;
  templateFileName: string;
  templateSha256: string;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}
