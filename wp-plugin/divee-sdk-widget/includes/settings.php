<?php
/**
 * Settings helper functions
 *
 * @package DiveeSdkWpPlugin
 */

defined( 'ABSPATH' ) || exit;

/**
 * Get current singular post ID from the queried object.
 *
 * @return int
 */
function divee_sdk_wp_get_current_post_id() {
	if ( ! is_singular() ) {
		return 0;
	}

	$post_id = get_queried_object_id();

	return $post_id ? (int) $post_id : 0;
}

/**
 * Get all post types for checkbox display
 */
function divee_sdk_wp_get_all_post_types() {
	$args = array(
		'public' => true,
	);
	return get_post_types( $args, 'objects' );
}

/**
 * Get enabled post types from settings
 */
function divee_sdk_wp_get_enabled_post_types() {
	$post_types = get_option( 'divee_sdk_wp_post_types', array( 'post', 'page' ) );
	return is_array( $post_types ) ? $post_types : array();
}

/**
 * Check if widget should display on current post
 */
function divee_sdk_wp_should_display_widget() {
	if ( is_admin() || ! is_singular() ) {
		return false;
	}

	$post_id = divee_sdk_wp_get_current_post_id();
	if ( ! $post_id ) {
		return false;
	}

	$post_type = get_post_type( $post_id );
	$enabled_types = divee_sdk_wp_get_enabled_post_types();

	if ( ! in_array( $post_type, $enabled_types, true ) ) {
		return false;
	}

	// Check per-post disable flag
	if ( get_post_meta( $post_id, '_divee_sdk_wp_disable', true ) ) {
		return false;
	}

	return true;
}

/**
 * Get the configured Project ID.
 *
 * @return string
 */
function divee_sdk_wp_get_project_id() {
	return trim( (string) get_option( 'divee_sdk_wp_project_id', '' ) );
}

/**
 * Get widget placement mode.
 *
 * @return string
 */
function divee_sdk_wp_get_placement_mode() {
	$mode = get_option( 'divee_sdk_wp_placement_mode', 'auto_bottom' );
	return divee_sdk_wp_sanitize_placement_mode( $mode );
}

/**
 * Sanitize project ID
 */
function divee_sdk_wp_sanitize_project_id( $value ) {
	return sanitize_text_field( $value );
}

/**
 * Validate post types array
 */
function divee_sdk_wp_validate_post_types( $value ) {
	if ( ! is_array( $value ) ) {
		return array( 'post', 'page' );
	}

	$all_types = array_keys( divee_sdk_wp_get_all_post_types() );
	return array_filter( $value, function( $type ) use ( $all_types ) {
		return in_array( $type, $all_types, true );
	});
}

/**
 * Sanitize placement mode option.
 *
 * @param string $value Placement mode from settings.
 * @return string
 */
function divee_sdk_wp_sanitize_placement_mode( $value ) {
	$allowed = array( 'auto_bottom', 'auto_top', 'shortcode' );
	$value   = sanitize_key( (string) $value );

	if ( ! in_array( $value, $allowed, true ) ) {
		return 'auto_bottom';
	}

	return $value;
}
