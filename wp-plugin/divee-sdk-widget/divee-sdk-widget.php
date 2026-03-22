<?php
/**
 * Plugin Name: Divee SDK Widget
 * Plugin URI: https://divee.ai
 * Description: Embed the Divee AI widget on WordPress posts and pages with one-click setup.
 * Version: 1.0.0
 * Author: Divee
 * License: GPL v2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: divee-sdk-widget
 * Domain Path: /languages
 *
 * @package DiveeSdkWpPlugin
 */

defined( 'ABSPATH' ) || exit;

define( 'DIVEE_SDK_WP_PLUGIN_VERSION', '1.0.0' );
define( 'DIVEE_SDK_WP_PLUGIN_PATH', plugin_dir_path( __FILE__ ) );

require_once DIVEE_SDK_WP_PLUGIN_PATH . 'includes/settings.php';
require_once DIVEE_SDK_WP_PLUGIN_PATH . 'admin/settings-page.php';
require_once DIVEE_SDK_WP_PLUGIN_PATH . 'public/load-widget.php';

add_action( 'admin_menu', 'divee_sdk_wp_register_admin_menu' );
add_action( 'admin_init', 'divee_sdk_wp_register_settings' );
add_action( 'wp_head', 'divee_sdk_wp_render_widget_script', 20 );
add_shortcode( 'divee_widget', 'divee_sdk_wp_render_shortcode_mount' );

/**
 * Activation hook: Set default options
 */
function divee_sdk_wp_activate() {
	if ( ! get_option( 'divee_sdk_wp_project_id' ) ) {
		add_option( 'divee_sdk_wp_project_id', '' );
	}
	if ( ! get_option( 'divee_sdk_wp_post_types' ) ) {
		add_option( 'divee_sdk_wp_post_types', array( 'post', 'page' ) );
	}
	if ( ! get_option( 'divee_sdk_wp_placement_mode' ) ) {
		add_option( 'divee_sdk_wp_placement_mode', 'auto_bottom' );
	}
}
register_activation_hook( __FILE__, 'divee_sdk_wp_activate' );

/**
 * Deactivation hook: Plugin cleanup
 */
function divee_sdk_wp_deactivate() {
	// Plugin can remain inactive without cleanup
}
register_deactivation_hook( __FILE__, 'divee_sdk_wp_deactivate' );

/**
 * Uninstall hook: Remove all plugin data
 */
function divee_sdk_wp_uninstall() {
	delete_option( 'divee_sdk_wp_project_id' );
	delete_option( 'divee_sdk_wp_post_types' );
	delete_option( 'divee_sdk_wp_placement_mode' );
	
	// Remove post meta for per-post disable flag
	delete_post_meta_by_key( '_divee_sdk_wp_disable' );
}
register_uninstall_hook( __FILE__, 'divee_sdk_wp_uninstall' );

/**
 * Add admin notice if project ID not configured
 */
function divee_sdk_wp_admin_notice() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}

	$project_id = get_option( 'divee_sdk_wp_project_id' );
	if ( empty( $project_id ) ) {
		?>
		<div class="notice notice-warning is-dismissible">
			<p>
				<?php
				printf(
					/* translators: %s: Settings page URL */
					esc_html__( 'Divee SDK: Please configure your Project ID in %s to activate the widget.', 'divee-sdk-widget' ),
					'<a href="' . esc_url( admin_url( 'options-general.php?page=divee-sdk-wp-settings' ) ) . '">' . esc_html__( 'settings', 'divee-sdk-widget' ) . '</a>'
				);
				?>
			</p>
		</div>
		<?php
	}
}
add_action( 'admin_notices', 'divee_sdk_wp_admin_notice' );
