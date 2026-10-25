export type ViewMode = "grid" | "list";

export interface Collection {
  id: string;
  name: string;
  description: string;
  thumbnail_data: string | null;
  created_at: string;
  updated_at: string;
  publication_count?: number;
}

export interface Publication {
  id: string;
  archive_identifier: string;
  pdf_filename: string;
  source_url: string;
  title: string;
  date: string;
  publisher: string;
  creator: string;
  description: string;
  language: string;
  rights: string;
  subjects: string[];
  metadata_json: string;
  overrides_json: string;
  thumbnail_data: string | null;
  local_pdf_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicationDraft {
  archive_identifier: string;
  pdf_filename: string;
  source_url: string;
  title: string;
  date: string;
  publisher: string;
  creator: string;
  description: string;
  language: string;
  rights: string;
  subjects: string[];
  metadata_json: string;
  thumbnail_data: string | null;
}
