/**
 * Auto-generated Supabase types.
 *
 * Once your Supabase project is up and running:
 *   1. supabase link --project-ref YOUR_REF
 *   2. npm run types:gen
 *
 * That will overwrite this file with the real generated types.
 * The minimal shape below is enough to make the app compile in the meantime.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          username: string;
          full_name: string | null;
          company: string | null;
          role: 'viewer' | 'contributor' | 'admin';
          access_level: 'open' | 'internal' | 'restricted' | 'paid';
          must_change_password: boolean;
          language: string;
          theme: string;
          created_at: string;
          last_seen_at: string | null;
        };
        Insert: Partial<Database['public']['Tables']['profiles']['Row']> & {
          id: string;
          username: string;
        };
        Update: Partial<Database['public']['Tables']['profiles']['Row']>;
        Relationships: [];
      };
      sources: {
        Row: {
          id: string;
          slug: string;
          name: string;
          name_en: string | null;
          description: string | null;
          base_url: string | null;
          logo_url: string | null;
          trust_level: number;
          is_active: boolean;
          created_at: string;
          // Scraper subsystem
          scrape_mode: 'none' | 'crawler' | 'manual_import' | 'both';
          scrape_config: Json;
          scrape_interval_hours: number | null;
          last_scraped_at: string | null;
          auto_publish: boolean;
        };
        Insert: Partial<Database['public']['Tables']['sources']['Row']> & {
          slug: string;
          name: string;
        };
        Update: Partial<Database['public']['Tables']['sources']['Row']>;
        Relationships: [];
      };
      scrape_runs: {
        Row: {
          id: string;
          source_id: string;
          trigger: 'cron' | 'manual' | 'import';
          status: 'running' | 'ok' | 'error' | 'partial' | 'cancelled';
          started_at: string;
          finished_at: string | null;
          discovered: number;
          added: number;
          updated: number;
          skipped: number;
          errors: number;
          error_log: Json;
          triggered_by: string | null;
          created_at: string;
        };
        Insert: Partial<Database['public']['Tables']['scrape_runs']['Row']> & {
          source_id: string;
          trigger: 'cron' | 'manual' | 'import';
        };
        Update: Partial<Database['public']['Tables']['scrape_runs']['Row']>;
        Relationships: [];
      };
      scrape_queue: {
        Row: {
          id: string;
          source_id: string;
          run_id: string | null;
          url: string;
          url_hash: string;
          content_hash: string | null;
          title_hint: string | null;
          status: 'pending' | 'fetching' | 'analyzing' | 'imported' | 'skipped' | 'error';
          document_id: string | null;
          error: string | null;
          discovered_at: string;
          fetched_at: string | null;
          imported_at: string | null;
        };
        Insert: Partial<Database['public']['Tables']['scrape_queue']['Row']> & {
          source_id: string;
          url: string;
        };
        Update: Partial<Database['public']['Tables']['scrape_queue']['Row']>;
        Relationships: [];
      };
      categories: {
        Row: {
          id: string;
          slug: string;
          path: unknown;
          name: string;
          name_en: string | null;
          description: string | null;
          parent_id: string | null;
          sort_order: number;
          created_at: string;
        };
        Insert: Partial<Database['public']['Tables']['categories']['Row']> & {
          slug: string;
          name: string;
        };
        Update: Partial<Database['public']['Tables']['categories']['Row']>;
        Relationships: [];
      };
      documents: {
        Row: {
          id: string;
          title: string;
          title_en: string | null;
          description: string | null;
          description_en: string | null;
          source_id: string | null;
          document_type: 'rb_blad' | 'leidbeining' | 'rannsokn' | 'handbok' | 'annad';
          language: string;
          reference_code: string | null;
          source_ref: string | null;
          version: string | null;
          published_date: string | null;
          access_level: 'open' | 'internal' | 'restricted' | 'paid';
          status: 'draft' | 'pending_review' | 'published' | 'archived';
          file_path: string | null;
          external_url: string | null;
          page_count: number | null;
          extracted_text: string | null;
          metadata: Json;
          uploaded_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['documents']['Row']> & {
          title: string;
        };
        Update: Partial<Database['public']['Tables']['documents']['Row']>;
        Relationships: [];
      };
      document_categories: {
        Row: {
          id: string;
          document_id: string;
          category_id: string;
          is_primary: boolean;
          created_at: string;
        };
        Insert: Partial<Database['public']['Tables']['document_categories']['Row']> & {
          document_id: string;
          category_id: string;
        };
        Update: Partial<Database['public']['Tables']['document_categories']['Row']>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_admin: { Args: Record<string, never>; Returns: boolean };
      my_access_level: {
        Args: Record<string, never>;
        Returns: 'open' | 'internal' | 'restricted' | 'paid';
      };
      sources_due_for_scrape: {
        Args: Record<string, never>;
        Returns: Database['public']['Tables']['sources']['Row'][];
      };
    };
   Enums: {
      user_role: 'viewer' | 'contributor' | 'admin';
      access_level: 'open' | 'internal' | 'restricted' | 'paid';
      document_type: 'rb_blad' | 'leidbeining' | 'rannsokn' | 'handbok' | 'annad';
      doc_status: 'draft' | 'pending_review' | 'published' | 'archived';
    };
    CompositeTypes: Record<string, never>;
  };
}

export type Document = Database['public']['Tables']['documents']['Row'];
export type Source = Database['public']['Tables']['sources']['Row'];
export type Category = Database['public']['Tables']['categories']['Row'];
export type Profile = Database['public']['Tables']['profiles']['Row'];
export type ScrapeRun = Database['public']['Tables']['scrape_runs']['Row'];
export type ScrapeQueueItem = Database['public']['Tables']['scrape_queue']['Row'];
