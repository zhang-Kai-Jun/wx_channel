package database

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// normalizeLegacyTimestamps 保留旧驱动时间的精度和时区，移除 Go 专用后缀。
func normalizeLegacyTimestamps(tx *sql.Tx) error {
	rows, err := tx.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		return err
	}
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			rows.Close()
			return err
		}
		tables = append(tables, table)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, table := range tables {
		cols, err := loadColumns(tx, table)
		if err != nil {
			return err
		}
		for _, col := range cols {
			switch strings.ToUpper(col.Type) {
			case "DATE", "DATETIME", "TIMESTAMP":
				if err := normalizeTimestampColumn(tx, table, col.Name); err != nil {
					return fmt.Errorf("normalize %s.%s: %w", table, col.Name, err)
				}
			}
		}
	}
	return nil
}

func normalizeTimestampColumn(tx *sql.Tx, table, column string) error {
	query := fmt.Sprintf(`SELECT rowid, CAST(%q AS TEXT) FROM %q WHERE instr(%q, ' +') > 0 OR instr(%q, ' -') > 0`, column, table, column, column)
	rows, err := tx.Query(query)
	if err != nil {
		return err
	}
	type update struct {
		rowID int64
		value string
	}
	var updates []update
	for rows.Next() {
		var rowID int64
		var raw string
		if err := rows.Scan(&rowID, &raw); err != nil {
			rows.Close()
			return err
		}
		// 旧格式为 date time offset zone [m=...]；数值偏移已完整表达时区。
		parts := strings.Fields(raw)
		if len(parts) < 4 {
			rows.Close()
			return fmt.Errorf("invalid legacy timestamp at row %d", rowID)
		}
		value, err := time.Parse("2006-01-02 15:04:05.999999999 -0700", strings.Join(parts[:3], " "))
		if err != nil {
			rows.Close()
			return fmt.Errorf("parse row %d: %w", rowID, err)
		}
		updates = append(updates, update{rowID, value.Format("2006-01-02 15:04:05.999999999-07:00")})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, item := range updates {
		if _, err := tx.Exec(fmt.Sprintf(`UPDATE %q SET %q = ? WHERE rowid = ?`, table, column), item.value, item.rowID); err != nil {
			return err
		}
	}
	return nil
}
